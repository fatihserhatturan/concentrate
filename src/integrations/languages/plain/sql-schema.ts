// A reader for the DDL of SQL migrations and schema files: `CREATE TABLE`,
// `ALTER TABLE`, `CREATE VIEW`, `CREATE INDEX` and the `DROP`s and renames
// that undo them, applied in order to a schema. It is a scanner, not a
// parser: the vendored sql grammar rejects valid code (`LIMIT $2`, MySQL
// backticks and `/*! … */`, `FOR NO KEY UPDATE`), and DDL needs only the
// statement boundaries and the top level of one parenthesis. Comments,
// strings, quoted identifiers and `$$ … $$` bodies are skipped, so a function
// body that creates a temporary table declares nothing.

export type SqlColumn = {
  name: string;
  type: string;
  optional: boolean;
  isId: boolean;
  isUnique: boolean;
  references: string | null;
};

export type SqlIndex = { name: string | null; columns: string[]; unique: boolean };

export type SqlChange = { file: string; line: number; order: number; change: string };

export type SqlTable = {
  name: string;
  schemaName: string | null;
  kind: "table" | "view";
  // Where it was first created.
  file: string;
  line: number;
  columns: SqlColumn[];
  indexes: SqlIndex[];
  changes: SqlChange[];
};

export type SqlStatement = { text: string; line: number };

const NAME = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${NAME}(?:\s*\.\s*${NAME})*`;
const MAX_CHANGES = 50;

// Statements of a file, comments blanked (line breaks kept) and `$$` bodies
// and strings kept as placeholders; each with the line it starts on. Text
// after `-- +goose Down` / `-- +migrate Down` is the undo half of a migration
// and is not read.
export function splitStatements(source: string): SqlStatement[] {
  const statements: SqlStatement[] = [];
  const down = /^\s*--\s*\+(?:goose|migrate)\s+Down\b/imu.exec(source);
  const text = down ? source.slice(0, down.index) : source;
  let current = "";
  let start = -1;
  let line = 1;
  let statementLine = 1;
  const push = () => {
    const trimmed = current.trim();
    if (trimmed !== "") statements.push({ text: trimmed.replace(/\s+/gu, " "), line: statementLine });
    current = "";
    start = -1;
  };
  const add = (chunk: string) => {
    if (start === -1 && chunk.trim() !== "") {
      start = line;
      statementLine = line;
    }
    current += chunk;
  };
  let index = 0;
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "-" && next === "-") {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
    } else if (char === "#" && /^#[^\n]*/u.test(text.slice(index)) && isMysqlHashComment(text, index)) {
      const end = text.indexOf("\n", index);
      index = end === -1 ? text.length : end;
    } else if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      line += (text.slice(index, stop).match(/\n/gu) ?? []).length;
      add(" ");
      index = stop;
    } else if (char === "'") {
      const stop = quoteEnd(text, index, "'");
      line += (text.slice(index, stop + 1).match(/\n/gu) ?? []).length;
      add("''");
      index = stop + 1;
    } else if (char === "$" && /^\$(?:[A-Za-z_]\w*)?\$/u.test(text.slice(index, index + 40))) {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/u.exec(text.slice(index, index + 40))![0];
      const end = text.indexOf(tag, index + tag.length);
      const stop = end === -1 ? text.length : end + tag.length;
      line += (text.slice(index, stop).match(/\n/gu) ?? []).length;
      add("''");
      index = stop;
    } else if (char === "\"" || char === "`") {
      const stop = quoteEnd(text, index, char);
      add(text.slice(index, stop + 1));
      index = stop + 1;
    } else if (char === ";") {
      push();
      index += 1;
    } else {
      if (char === "\n") line += 1;
      add(char);
      index += 1;
    }
  }
  push();
  return statements;
}

// `#` starts a comment in MySQL only; in PostgreSQL it is an operator, rare
// in DDL. Treat it as a comment at the start of a line.
function isMysqlHashComment(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf("\n", index - 1) + 1;
  return text.slice(lineStart, index).trim() === "";
}

function quoteEnd(text: string, start: number, quote: string): number {
  for (let index = start + 1; index < text.length; index += 1) {
    if (text[index] === "\\" && quote === "'") index += 1;
    else if (text[index] === quote) {
      if (text[index + 1] === quote) index += 1;
      else return index;
    }
  }
  return text.length - 1;
}

function unquote(name: string): string {
  const first = name[0];
  if (first === "\"") return name.slice(1, -1).replace(/""/gu, "\"");
  if (first === "`") return name.slice(1, -1);
  if (first === "[") return name.slice(1, -1);
  return name;
}

// `public.users` → schema `public`, name `users`.
function splitQualified(text: string): { schema: string | null; name: string } {
  const parts = [...text.matchAll(new RegExp(NAME, "gu"))].map((match) => unquote(match[0]));
  return { schema: parts.length > 1 ? parts[parts.length - 2]! : null, name: parts[parts.length - 1] ?? text };
}

const keyOf = (name: string) => name.toLowerCase();

function splitTop(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "'" || char === "\"" || char === "`") index = quoteEnd(text, index, char);
    else if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  const last = text.slice(start).trim();
  if (last !== "") parts.push(last);
  return parts;
}

// The text inside the parenthesis that opens at `open`.
function parenthesized(text: string, open: number): { inside: string; end: number } | null {
  let depth = 0;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "'" || char === "\"" || char === "`") index = quoteEnd(text, index, char);
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return { inside: text.slice(open + 1, index), end: index };
  }
  return null;
}

const CONSTRAINT_WORDS = /^(?:CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK|INDEX|KEY|FULLTEXT|SPATIAL|EXCLUDE|LIKE|PERIOD)\b/iu;
const TYPE_END = /^(?:NOT\s+NULL|NULL|DEFAULT|PRIMARY|UNIQUE|REFERENCES|CHECK|COLLATE|GENERATED|AUTO_INCREMENT|AUTOINCREMENT|COMMENT|CONSTRAINT|ON\s+UPDATE|IDENTITY|AS|CHARACTER\s+SET|CHARSET|ENCODE|COMPRESSION|STORAGE)\b/iu;

function parseColumn(definition: string): SqlColumn | null {
  const match = new RegExp(`^(${NAME})\\s*(.*)$`, "isu").exec(definition.trim());
  if (!match) return null;
  const rest = match[2]!;
  // The type ends at the first constraint word outside parentheses.
  let type = rest;
  let depth = 0;
  for (let index = 0; index < rest.length; index += 1) {
    const char = rest[index]!;
    if (char === "(") depth += 1;
    else if (char === ")") depth = Math.max(0, depth - 1);
    else if (depth === 0 && (index === 0 || /\s/u.test(rest[index - 1]!)) && TYPE_END.test(rest.slice(index))) {
      type = rest.slice(0, index);
      break;
    }
  }
  const primary = /\bPRIMARY\s+KEY\b/iu.test(rest);
  const references = new RegExp(String.raw`\bREFERENCES\s+(${QUALIFIED})\s*(?:\(\s*(${NAME})\s*\))?`, "iu").exec(rest);
  return {
    name: unquote(match[1]!),
    type: type.trim().replace(/\s+/gu, " "),
    optional: !primary && !/\bNOT\s+NULL\b/iu.test(rest),
    isId: primary,
    isUnique: /\bUNIQUE\b/iu.test(rest),
    references: references ? `${splitQualified(references[1]!).name}${references[2] ? `.${unquote(references[2])}` : ""}` : null,
  };
}

export class SqlSchema {
  readonly tables = new Map<string, SqlTable>();

  apply(statement: SqlStatement, file: string, order: number): void {
    const text = statement.text;
    const record = (table: SqlTable, change: string) => {
      if (table.changes.length < MAX_CHANGES) table.changes.push({ file, line: statement.line, order, change });
    };
    let match: RegExpExecArray | null;

    if ((match = new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:GLOBAL\s+|LOCAL\s+)?(?:TEMPORARY|TEMP)\s+|UNLOGGED\s+|EXTERNAL\s+|VIRTUAL\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})`, "iu").exec(text))) {
      this.createTable(match, text, file, statement.line, order);
    } else if ((match = new RegExp(String.raw`^CREATE\s+(?:OR\s+REPLACE\s+)?(?:(?:TEMPORARY|TEMP|RECURSIVE|MATERIALIZED)\s+)*VIEW\s+(?:IF\s+NOT\s+EXISTS\s+)?(${QUALIFIED})\s*(\()?`, "iu").exec(text))) {
      const { schema, name } = splitQualified(match[1]!);
      const columns: SqlColumn[] = [];
      if (match[2]) {
        const list = parenthesized(text, match.index + match[0].length - 1);
        for (const part of list ? splitTop(list.inside) : []) columns.push({ name: unquote(part.trim()), type: "", optional: true, isId: false, isUnique: false, references: null });
      }
      const existing = this.tables.get(keyOf(name));
      const table: SqlTable = existing && existing.kind === "view"
        ? { ...existing, columns: columns.length > 0 ? columns : existing.columns }
        : { name, schemaName: schema, kind: "view", file, line: statement.line, columns, indexes: [], changes: existing?.changes ?? [] };
      this.tables.set(keyOf(name), table);
      record(table, "create-view");
    } else if ((match = new RegExp(String.raw`^ALTER\s+(?:TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(${QUALIFIED})\s+(.*)$`, "iu").exec(text))) {
      this.alterTable(match[1]!, match[2]!, record);
    } else if ((match = new RegExp(String.raw`^CREATE\s+(UNIQUE\s+)?(?:FULLTEXT\s+|SPATIAL\s+|CLUSTERED\s+|NONCLUSTERED\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(?:(${NAME})\s+)?ON\s+(?:ONLY\s+)?(${QUALIFIED})`, "iu").exec(text))) {
      const table = this.tables.get(keyOf(splitQualified(match[3]!).name));
      if (!table) return;
      const open = text.indexOf("(", match.index + match[0].length);
      const list = open === -1 ? null : parenthesized(text, open);
      const columns = (list ? splitTop(list.inside) : []).map((part) => part.replace(/\s+(?:ASC|DESC)\b.*$/iu, "").trim());
      table.indexes.push({ name: match[2] ? unquote(match[2]) : null, columns, unique: match[1] !== undefined });
      record(table, "create-index");
    } else if ((match = new RegExp(String.raw`^DROP\s+(?:MATERIALIZED\s+)?(TABLE|VIEW)\s+(?:IF\s+EXISTS\s+)?(.*?)(?:\s+(?:CASCADE|RESTRICT))?$`, "iu").exec(text))) {
      for (const part of splitTop(match[2]!)) this.tables.delete(keyOf(splitQualified(part).name));
    } else if ((match = new RegExp(String.raw`^DROP\s+INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+EXISTS\s+)?(.*?)(?:\s+ON\s+(${QUALIFIED}))?(?:\s+(?:CASCADE|RESTRICT))?$`, "iu").exec(text))) {
      const names = new Set(splitTop(match[1]!).map((part) => splitQualified(part).name.toLowerCase()));
      for (const table of this.tables.values()) {
        const before = table.indexes.length;
        table.indexes = table.indexes.filter((index) => !(index.name && names.has(index.name.toLowerCase())));
        if (table.indexes.length !== before) record(table, "drop-index");
      }
    } else if ((match = new RegExp(String.raw`^RENAME\s+TABLE\s+(.*)$`, "iu").exec(text))) {
      for (const part of splitTop(match[1]!)) {
        const pair = new RegExp(String.raw`^(${QUALIFIED})\s+TO\s+(${QUALIFIED})$`, "iu").exec(part);
        if (pair) this.rename(pair[1]!, pair[2]!, record);
      }
    }
  }

  private createTable(match: RegExpExecArray, text: string, file: string, line: number, order: number): void {
    const { schema, name } = splitQualified(match[1]!);
    const open = text.indexOf("(", match.index + match[0].length);
    const between = open === -1 ? "" : text.slice(match.index + match[0].length, open);
    // `CREATE TABLE a AS SELECT`, `(LIKE b)`, `PARTITION OF`: no column list of its own.
    const list = open !== -1 && !/\b(?:AS|PARTITION|INHERITS)\b/iu.test(between) ? parenthesized(text, open) : null;
    const columns: SqlColumn[] = [];
    const indexes: SqlIndex[] = [];
    const constraints: string[] = [];
    for (const part of list ? splitTop(list.inside) : []) {
      if (CONSTRAINT_WORDS.test(part)) constraints.push(part);
      else {
        const column = parseColumn(part);
        if (column) columns.push(column);
      }
    }
    const table: SqlTable = { name, schemaName: schema, kind: "table", file, line, columns, indexes, changes: [{ file, line, order, change: "create" }] };
    for (const constraint of constraints) this.applyConstraint(table, constraint);
    this.tables.set(keyOf(name), table);
  }

  // `PRIMARY KEY (a, b)`, `UNIQUE (a)`, `FOREIGN KEY (a) REFERENCES t (b)`,
  // `CONSTRAINT n …`, MySQL `KEY n (a)` / `INDEX n (a)`.
  private applyConstraint(table: SqlTable, definition: string): void {
    const text = definition.replace(new RegExp(String.raw`^CONSTRAINT\s+(?:${NAME}\s+)?`, "iu"), "");
    const columnsOf = (from: number): string[] => {
      const open = text.indexOf("(", from);
      const list = open === -1 ? null : parenthesized(text, open);
      return list ? splitTop(list.inside).map((part) => unquote(part.trim().replace(/\s*\(.*$/u, ""))) : [];
    };
    const find = (name: string) => table.columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
    if (/^PRIMARY\s+KEY\b/iu.test(text)) {
      for (const name of columnsOf(0)) {
        const column = find(name);
        if (column) Object.assign(column, { isId: true, optional: false });
      }
    } else if (/^UNIQUE\b/iu.test(text)) {
      const names = columnsOf(0);
      if (names.length === 1) {
        const column = find(names[0]!);
        if (column) column.isUnique = true;
      }
      table.indexes.push({ name: /^UNIQUE\s+(?:KEY\s+|INDEX\s+)?(?!\()(\S+)/iu.exec(text)?.[1] ?? null, columns: names, unique: true });
    } else if (/^FOREIGN\s+KEY\b/iu.test(text)) {
      const reference = new RegExp(String.raw`\bREFERENCES\s+(${QUALIFIED})\s*(?:\(\s*(${NAME})\s*\))?`, "iu").exec(text);
      const names = columnsOf(0);
      if (reference && names.length > 0) {
        const column = find(names[0]!);
        if (column) column.references = `${splitQualified(reference[1]!).name}${reference[2] ? `.${unquote(reference[2])}` : ""}`;
      }
    } else if (/^(?:KEY|INDEX|FULLTEXT|SPATIAL)\b/iu.test(text)) {
      table.indexes.push({ name: /^(?:FULLTEXT\s+|SPATIAL\s+)?(?:KEY|INDEX)\s+(?!\()(\S+)/iu.exec(text)?.[1] ?? null, columns: columnsOf(0), unique: false });
    }
  }

  private alterTable(rawName: string, actions: string, record: (table: SqlTable, change: string) => void): void {
    const { name } = splitQualified(rawName);
    const table = this.tables.get(keyOf(name));
    if (!table) return;
    const find = (column: string) => table.columns.find((entry) => entry.name.toLowerCase() === unquote(column.trim()).toLowerCase());
    for (const action of splitTop(actions)) {
      let match: RegExpExecArray | null;
      if ((match = /^ADD\s+(?:COLUMN\s+)?(?:IF\s+NOT\s+EXISTS\s+)?(.*)$/iu.exec(action))) {
        const definition = match[1]!;
        if (CONSTRAINT_WORDS.test(definition)) {
          this.applyConstraint(table, definition);
          record(table, "add-constraint");
          continue;
        }
        const column = parseColumn(definition.replace(/^\(\s*/u, "").replace(/\s*\)$/u, ""));
        if (!column) continue;
        const existing = find(column.name);
        if (existing) Object.assign(existing, column);
        else table.columns.push(column);
        record(table, "add-column");
      } else if ((match = new RegExp(String.raw`^DROP\s+(?:COLUMN\s+)?(?:IF\s+EXISTS\s+)?(${NAME})`, "iu").exec(action)) && !/^DROP\s+(?:CONSTRAINT|INDEX|KEY|PRIMARY|FOREIGN|DEFAULT)\b/iu.test(action)) {
        const before = table.columns.length;
        table.columns = table.columns.filter((column) => column.name.toLowerCase() !== unquote(match![1]!).toLowerCase());
        if (table.columns.length !== before) record(table, "drop-column");
      } else if ((match = new RegExp(String.raw`^RENAME\s+COLUMN\s+(${NAME})\s+TO\s+(${NAME})`, "iu").exec(action))) {
        const column = find(match[1]!);
        if (column) {
          column.name = unquote(match[2]!);
          record(table, "rename-column");
        }
      } else if ((match = new RegExp(String.raw`^RENAME\s+(?:TO\s+|AS\s+)?(${QUALIFIED})$`, "iu").exec(action))) {
        this.rename(rawName, match[1]!, record);
      } else if ((match = new RegExp(String.raw`^ALTER\s+(?:COLUMN\s+)?(${NAME})\s+(.*)$`, "iu").exec(action))) {
        const column = find(match[1]!);
        if (!column) continue;
        const change = match[2]!;
        const type = /^(?:SET\s+DATA\s+)?TYPE\s+(.*?)(?:\s+(?:USING|COLLATE)\b.*)?$/iu.exec(change);
        if (type) column.type = type[1]!.trim();
        else if (/^SET\s+NOT\s+NULL\b/iu.test(change)) column.optional = false;
        else if (/^DROP\s+NOT\s+NULL\b/iu.test(change)) column.optional = true;
        else continue;
        record(table, "alter-column");
      } else if ((match = /^MODIFY\s+(?:COLUMN\s+)?(.*)$/iu.exec(action))) {
        const column = parseColumn(match[1]!);
        const existing = column ? find(column.name) : undefined;
        if (column && existing) {
          Object.assign(existing, { type: column.type, optional: column.optional, isUnique: existing.isUnique || column.isUnique });
          record(table, "alter-column");
        }
      } else if ((match = new RegExp(String.raw`^CHANGE\s+(?:COLUMN\s+)?(${NAME})\s+(.*)$`, "iu").exec(action))) {
        const column = parseColumn(match[2]!);
        const existing = find(match[1]!);
        if (column && existing) {
          Object.assign(existing, { name: column.name, type: column.type, optional: column.optional });
          record(table, "alter-column");
        }
      } else if (/^DROP\s+(?:CONSTRAINT|PRIMARY|FOREIGN|INDEX|KEY)\b/iu.test(action)) {
        record(table, "drop-constraint");
      }
    }
  }

  private rename(from: string, to: string, record: (table: SqlTable, change: string) => void): void {
    const oldName = splitQualified(from).name;
    const table = this.tables.get(keyOf(oldName));
    if (!table) return;
    const target = splitQualified(to);
    this.tables.delete(keyOf(oldName));
    table.name = target.name;
    this.tables.set(keyOf(target.name), table);
    record(table, "rename");
  }
}

// The tables a literal SQL statement reads and writes:
//   SELECT … FROM a JOIN b       → read a, read b
//   INSERT [INTO] a … [SELECT … FROM b] → create a (upsert with ON CONFLICT /
//                                  ON DUPLICATE KEY), read b; MySQL's INTO is
//                                  optional (`INSERT article SET …`)
//   UPDATE a SET … FROM b        → update a, read b
//   DELETE FROM a USING b        → delete a, read b
//   WITH x AS (INSERT INTO a …) SELECT … → the CTE's own statement counts
//                                  (create a), apart from the main query
// Names defined by WITH are not tables; a schema-qualified name keeps its
// last part. Other statements (DDL, transactions) touch no table here.

export type SqlTableAccess = { table: string; operation: "read" | "create" | "update" | "delete" | "upsert" };

const NAME = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${NAME}(?:\s*\.\s*${NAME})*`;
const KEYWORD = String.raw`(?:WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|GROUP|ORDER|LIMIT|OFFSET|HAVING|UNION|EXCEPT|INTERSECT|SET|USING|NATURAL|WINDOW|RETURNING|VALUES|FOR|AND|OR|SELECT|DEFAULT)\b`;
const ALIAS = String.raw`(?:\s+(?:AS\s+)?(?!${KEYWORD})${NAME})?`;
const NOT_TABLES = new Set(["select", "lateral", "unnest", "values", "only", "dual"]);

export function sqlTableAccesses(sql: string): SqlTableAccess[] {
  const cleaned = sql
    .replace(/--[^\n]*/gu, " ")
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/'(?:[^']|'')*'/gu, "''")
    .replace(/\s+/gu, " ")
    .trim();
  const { text, nested } = extractDmlCtes(cleaned);
  const ctes = new Set([...text.matchAll(new RegExp(String.raw`(?:\bWITH(?:\s+RECURSIVE)?|,)\s+(${NAME})\s*(?:\([^)]*\)\s*)?AS\s*\(`, "giu"))].map((match) => tableName(match[1]!)));
  const accesses: SqlTableAccess[] = [];
  const add = (raw: string, operation: SqlTableAccess["operation"]) => {
    const table = tableName(raw);
    if (!table || ctes.has(table) || NOT_TABLES.has(table.toLowerCase())) return;
    if (!accesses.some((access) => access.table === table && access.operation === operation)) accesses.push({ table, operation });
  };

  for (const access of nested) add(access.table, access.operation);

  // The statement after any WITH clauses.
  const main = /\b(INSERT|UPDATE|DELETE|SELECT|REPLACE|MERGE)\b/iu.exec(stripCtes(text));
  const verb = main?.[1]?.toUpperCase();
  let rest = text;
  if (verb === "INSERT" || verb === "REPLACE") {
    const target = new RegExp(String.raw`\b(?:INSERT|REPLACE)\s+(?:(?:LOW_PRIORITY|DELAYED|HIGH_PRIORITY)\s+)?(?:OR\s+\w+\s+|IGNORE\s+)?(?:INTO\s+)?(?!INTO\b)(${QUALIFIED})`, "iu").exec(text);
    if (target) {
      add(target[1]!, verb === "REPLACE" || /\bON\s+(?:CONFLICT|DUPLICATE\s+KEY)\b/iu.test(text) ? "upsert" : "create");
      rest = `${text.slice(0, target.index)} ${text.slice(target.index + target[0].length)}`;
    }
  } else if (verb === "UPDATE") {
    const target = new RegExp(String.raw`\bUPDATE\s+(?:ONLY\s+)?(${QUALIFIED})`, "iu").exec(text);
    if (target) {
      add(target[1]!, "update");
      rest = `${text.slice(0, target.index)} ${text.slice(target.index + target[0].length)}`;
    }
  } else if (verb === "DELETE") {
    const target = new RegExp(String.raw`\bDELETE\s+(?:\w+\s+)?FROM\s+(?:ONLY\s+)?(${QUALIFIED})`, "iu").exec(text);
    if (target) {
      add(target[1]!, "delete");
      rest = `${text.slice(0, target.index)} ${text.slice(target.index + target[0].length)}`;
    }
  } else if (verb !== "SELECT") {
    return accesses;
  }

  // Tables read: after FROM / JOIN / USING, with comma-separated lists.
  for (const match of rest.matchAll(new RegExp(String.raw`\b(FROM|JOIN|USING)\s+((?:${QUALIFIED})${ALIAS}(?:\s*,\s*${QUALIFIED}${ALIAS})*)`, "giu"))) {
    if (match[1]!.toUpperCase() === "USING" && /^\s*\(/u.test(rest.slice(match.index + match[1]!.length))) continue;
    for (const item of match[2]!.split(",")) {
      const name = new RegExp(`^\\s*(${QUALIFIED})`, "u").exec(item)?.[1];
      if (name) add(name, "read");
    }
  }
  return accesses;
}

// Data-modifying CTEs (`WITH ins AS (INSERT INTO a … RETURNING …)`): their
// accesses are the statement's own, and the body is blanked so its `FROM` /
// `USING` is not read as a table the main query reads.
function extractDmlCtes(text: string): { text: string; nested: SqlTableAccess[] } {
  const nested: SqlTableAccess[] = [];
  let result = text;
  const pattern = new RegExp(String.raw`(?:\bWITH(?:\s+RECURSIVE)?|,)\s+${NAME}\s*(?:\([^)]*\)\s*)?AS\s*(?:NOT\s+MATERIALIZED\s+|MATERIALIZED\s+)?\(`, "giu");
  for (const match of text.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < text.length && depth > 0; end += 1) {
      if (text[end] === "(") depth += 1;
      else if (text[end] === ")") depth -= 1;
    }
    const body = text.slice(start, end - 1);
    if (!/^\s*(?:INSERT|UPDATE|DELETE)\b/iu.test(body)) continue;
    nested.push(...sqlTableAccesses(body));
    result = result.replace(body, " ");
  }
  return { text: result, nested };
}

// The statement after the leading WITH clause: each definition is
// `name [(columns)] AS [MATERIALIZED] ( body )`, separated by commas.
function stripCtes(text: string): string {
  if (!/^\s*WITH\b/iu.test(text)) return text;
  const definition = new RegExp(String.raw`^\s*(?:RECURSIVE\s+)?${NAME}\s*(?:\([^)]*\)\s*)?AS\s*(?:NOT\s+MATERIALIZED\s+|MATERIALIZED\s+)?\(`, "iu");
  let rest = text.replace(/^\s*WITH\b/iu, "");
  for (;;) {
    const match = definition.exec(rest);
    if (!match) return rest;
    let depth = 1;
    let index = match[0].length;
    for (; index < rest.length && depth > 0; index += 1) {
      if (rest[index] === "(") depth += 1;
      else if (rest[index] === ")") depth -= 1;
    }
    rest = rest.slice(index);
    const comma = /^\s*,/u.exec(rest);
    if (!comma) return rest;
    rest = rest.slice(comma[0].length);
  }
}

function tableName(raw: string): string {
  const parts = raw.split(".").map((part) => part.trim().replace(/^["`[]|["`\]]$/gu, ""));
  return parts[parts.length - 1] ?? "";
}

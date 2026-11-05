// The tables a literal SQL statement reads and writes:
//   SELECT … FROM a JOIN b       → read a, read b
//   INSERT [INTO] a … [SELECT … FROM b] → create a (upsert with ON CONFLICT /
//                                  ON DUPLICATE KEY), read b; MySQL's INTO is
//                                  optional (`INSERT article SET …`)
//   UPDATE a SET … FROM b        → update a, read b
//   DELETE FROM a USING b        → delete a, read b
// Names defined by WITH are not tables; a schema-qualified name keeps its
// last part. Other statements (DDL, transactions) touch no table here.

export type SqlTableAccess = { table: string; operation: "read" | "create" | "update" | "delete" | "upsert" };

const NAME = String.raw`(?:"[^"]+"|\x60[^\x60]+\x60|\[[^\]]+\]|[A-Za-z_][\w$]*)`;
const QUALIFIED = String.raw`${NAME}(?:\s*\.\s*${NAME})*`;
const KEYWORD = String.raw`(?:WHERE|JOIN|LEFT|RIGHT|INNER|OUTER|FULL|CROSS|ON|GROUP|ORDER|LIMIT|OFFSET|HAVING|UNION|EXCEPT|INTERSECT|SET|USING|NATURAL|WINDOW|RETURNING|VALUES|FOR|AND|OR|SELECT|DEFAULT)\b`;
const ALIAS = String.raw`(?:\s+(?:AS\s+)?(?!${KEYWORD})${NAME})?`;
const NOT_TABLES = new Set(["select", "lateral", "unnest", "values", "only", "dual"]);

export function sqlTableAccesses(sql: string): SqlTableAccess[] {
  const text = sql
    .replace(/--[^\n]*/gu, " ")
    .replace(/\/\*[\s\S]*?\*\//gu, " ")
    .replace(/'(?:[^']|'')*'/gu, "''")
    .replace(/\s+/gu, " ")
    .trim();
  const ctes = new Set([...text.matchAll(new RegExp(String.raw`(?:\bWITH(?:\s+RECURSIVE)?|,)\s+(${NAME})\s*(?:\([^)]*\)\s*)?AS\s*\(`, "giu"))].map((match) => tableName(match[1]!)));
  const accesses: SqlTableAccess[] = [];
  const add = (raw: string, operation: SqlTableAccess["operation"]) => {
    const table = tableName(raw);
    if (!table || ctes.has(table) || NOT_TABLES.has(table.toLowerCase())) return;
    if (!accesses.some((access) => access.table === table && access.operation === operation)) accesses.push({ table, operation });
  };

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

function stripCtes(text: string): string {
  if (!/^\s*WITH\b/iu.test(text)) return text;
  // Skip balanced parentheses of each CTE body.
  let depth = 0;
  let last = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "(") depth += 1;
    else if (text[index] === ")") {
      depth -= 1;
      if (depth === 0) last = index + 1;
    }
  }
  return text.slice(last);
}

function tableName(raw: string): string {
  const parts = raw.split(".").map((part) => part.trim().replace(/^["`[]|["`\]]$/gu, ""));
  return parts[parts.length - 1] ?? "";
}

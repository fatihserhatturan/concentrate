import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { CppParsePlugin } from "../../languages/cpp/parser.js";
import { SqlSchema, splitStatements } from "../../languages/plain/sql-schema.js";
import { fileOfNodeId } from "../js-ts/resolution/data-access.js";
import { sqlTableAccesses } from "../go/sql.js";
import { findInvocations, ownerOf, readArguments, readCppSource, resolveString, stringConstants, matching, type CppSource } from "./scan.js";

// C and C++ data access: the SQL strings of the database libraries, mapped to
// the tables they touch (a DataModel of the library named by the table, which
// maps to the Table; the SQL of `.sql` files and the schema strings below
// enrich the same Table):
//   - sqlite3: `sqlite3_exec(db, "…")`, `sqlite3_prepare_v2` / `_v3` /
//     `sqlite3_prepare` / `sqlite3_prepare16_v2`, `sqlite3_mprintf`;
//   - SQLiteCpp: `SQLite::Statement q(db, "…")`, `db.exec("…")`, `execAndGet`;
//   - libpq: `PQexec`, `PQexecParams`, `PQprepare`, `PQsendQuery(Params)`;
//     libpqxx: `txn.exec("…")`, `exec_params`, `exec0` / `exec1`, `prepare`,
//     `query_value`;
//   - MySQL: `mysql_query`, `mysql_real_query`, `mysql_stmt_prepare`;
//     ODBC: `SQLExecDirect`, `SQLPrepare`;
//   - SOCI: `sql << "…"`, `sql.once << "…"`, `sql.prepare << "…"`;
//   - Qt SQL: `QSqlQuery q("…")`, `q.exec("…")`, `q.prepare("…")`;
//   - Drogon's DbClient: `execSqlAsync("…")`, `execSqlSync`, `execSqlAsyncFuture`.
// The SQL is a literal, a constant or a local string of the function (`+`
// concatenation too; an unknown part is a parameter). A `CREATE TABLE`
// string declares the table (columns kept). The access is ACCESSES_DATA from
// the function (and the route whose lambda holds it), its routes and
// entrypoints and the functions that call it; READS / WRITES to the tables
// follow from the JS/TS data-access contributor, which runs after this one.

type Candidate = { owner: string; routes: string[]; line: number; expression: string; sql: string; library: string };

type Family = { library: string; names: string; index: number; requires: RegExp; receiver: "none" | "any" | "method" };
const FAMILIES: Family[] = [
  { library: "sqlite3", names: "sqlite3_exec|sqlite3_prepare_v2|sqlite3_prepare_v3|sqlite3_prepare|sqlite3_prepare16_v2|sqlite3_prepare16", index: 1, requires: /\bsqlite3_/u, receiver: "none" },
  { library: "sqlite3", names: "sqlite3_mprintf|sqlite3_vmprintf", index: 0, requires: /\bsqlite3_/u, receiver: "none" },
  { library: "libpq", names: "PQexec|PQexecParams|PQsendQuery|PQsendQueryParams", index: 1, requires: /\bPQ\w+\(/u, receiver: "none" },
  { library: "libpq", names: "PQprepare", index: 2, requires: /\bPQprepare\b/u, receiver: "none" },
  { library: "mysql", names: "mysql_query|mysql_real_query|mysql_stmt_prepare", index: 1, requires: /\bmysql_/u, receiver: "none" },
  { library: "odbc", names: "SQLExecDirect[AW]?|SQLPrepare[AW]?", index: 1, requires: /\bSQL(?:ExecDirect|Prepare)/u, receiver: "none" },
  { library: "sqlitecpp", names: "exec|execAndGet", index: 0, requires: /\bSQLiteCpp\b|\bSQLite::/u, receiver: "method" },
  { library: "pqxx", names: "exec|exec0|exec1|exec_n|exec_params|exec_params0|exec_params1|exec_params_n|query_value|query|query1|query_n", index: 0, requires: /\bpqxx\b/u, receiver: "method" },
  { library: "pqxx", names: "prepare", index: 1, requires: /\bpqxx\b/u, receiver: "method" },
  { library: "qtsql", names: "exec|prepare|execBatch", index: 0, requires: /\bQSql(?:Query|Database)\b/u, receiver: "method" },
  { library: "drogon", names: "execSqlAsync|execSqlSync|execSqlAsyncFuture|execSqlCoro", index: 0, requires: /\bexecSql\w*\b/u, receiver: "method" },
];

export const cppDataAccessPlugin: CppParsePlugin = ({ fileNodeId, source: written, nodes }) => {
  const families = FAMILIES.filter((family) => family.requires.test(written));
  const hasSoci = /\bsoci\b/iu.test(written);
  const declares = /\b(?:SQLite::Statement|QSqlQuery)\b/u.test(written);
  if (families.length === 0 && !hasSoci && !declares) return;
  const source = readCppSource(written);
  const constants = stringConstants(source);
  const owner = ownerOf(nodes, fileNodeId);
  const functions = nodes
    .filter((node) => node.label === "Function" && node.properties.isDeclaration !== true && typeof node.properties.line === "number" && typeof node.properties.endLine === "number")
    .map((node) => ({ start: source.offsetOfLine(Number(node.properties.line)), end: source.offsetOfLine(Number(node.properties.endLine) + 1) }));
  const functionStart = (offset: number) => functions.filter((fn) => fn.start <= offset && offset < fn.end).sort((left, right) => (left.end - left.start) - (right.end - right.start))[0]?.start ?? 0;
  // Routes with a lambda handler that holds the line.
  const lambdas = nodes
    .filter((node) => node.label === "Route" && typeof node.properties.cppPending === "string")
    .flatMap((node) => {
      const pending = JSON.parse(String(node.properties.cppPending)) as { lambda: [number, number] | null };
      return pending.lambda ? [{ id: node.id, from: pending.lambda[0], to: pending.lambda[1] }] : [];
    });
  const candidates: Candidate[] = [];
  const add = (library: string, offset: number, expression: string, written: string) => {
    const sql = resolveString(source, written, offset, functionStart(offset), constants);
    if (sql === null) return;
    const line = source.lineAt(offset);
    candidates.push({
      owner: owner(line),
      routes: [...new Set(lambdas.filter((lambda) => lambda.from <= line && line <= lambda.to).map((lambda) => lambda.id))],
      line,
      expression: expression.length > 120 ? `${expression.slice(0, 117)}...` : expression,
      sql: sql.replace(/\$\{[^}]*\}/gu, "?"),
      library,
    });
  };

  for (const family of families) {
    for (const call of findInvocations(source, family.names)) {
      if (family.receiver === "none" ? call.receiver !== null : call.receiver === null) continue;
      const argument = call.args[family.index];
      if (argument !== undefined) add(family.library, call.start, `${call.prefix}${call.name}`, argument);
    }
  }
  // `SQLite::Statement query(db, "…")`, `QSqlQuery q("…")`.
  for (const match of source.code.matchAll(/\b(?:SQLite::)?(Statement)\s+\w+\s*[({]|\b(QSqlQuery)\s+\w+\s*[({]/gu)) {
    const open = match.index + match[0].length - 1;
    const close = matching(source.code, open);
    if (close === -1) continue;
    const { args } = readArguments(source, open, close);
    const sqlite = match[1] === "Statement";
    if (sqlite ? !/\bSQLite\b/u.test(written) : false) continue;
    const argument = sqlite ? args[1] : args[0];
    if (argument !== undefined) add(sqlite ? "sqlitecpp" : "qtsql", match.index, match[0].replace(/\s*[({]$/u, ""), argument);
  }
  // A `SQLite::Statement` member prepared in a constructor's initializer list: `mQuery(db, "SELECT …")`.
  if (/\bSQLite\b/u.test(written)) {
    const members = [...source.code.matchAll(/\b(?:SQLite::)?Statement\s+(\w+)\s*;/gu)].map((match) => match[1]!);
    if (members.length > 0) {
      for (const call of findInvocations(source, members.join("|"))) {
        if (call.receiver === null && call.args[1] !== undefined) add("sqlitecpp", call.start, call.name, call.args[1]);
      }
    }
  }
  // SOCI: `sql << "SELECT …"`, `sql.once << "…"`, `sql.prepare << "…"`.
  if (hasSoci) {
    for (const match of source.code.matchAll(/\b(\w+(?:\.(?:once|prepare))?)\s*<<\s*(?=(?:u8|L)?")/gu)) {
      const end = literalEnd(source, match.index + match[0].length);
      if (end === -1) continue;
      add("soci", match.index, `${match[1]} <<`, source.text.slice(match.index + match[0].length, end));
    }
  }

  candidates.sort((left, right) => left.line - right.line);
  const file = nodes.find((node) => node.id === fileNodeId);
  if (file && candidates.length > 0) file.properties.cppData = JSON.stringify(candidates);
};

// The end of the string literals (adjacent ones joined) that start at `from`.
function literalEnd(source: CppSource, from: number): number {
  let position = from;
  let end = -1;
  for (;;) {
    const match = /^\s*(?:u8|L)?"/u.exec(source.code.slice(position, position + 40));
    if (!match) return end;
    const open = position + match[0].length - 1;
    let close = open + 1;
    while (close < source.text.length && source.text[close] !== "\"" && source.text[close] !== "\n") close += source.text[close] === "\\" ? 2 : 1;
    if (source.text[close] !== "\"") return end;
    end = close + 1;
    position = end;
  }
}

type Access = { owner: string; extra: string[]; modelId: string; operation: string; library: string; line: number; expression: string };

export const cppDataAccessContributor: ISemanticContributor = {
  contribute(graph) {
    const files = graph.nodes.filter((node) => node.label === "File" && typeof node.properties.cppData === "string");
    if (files.length === 0) return;
    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const tables = new Map<string, GraphNode>();
    const table = (name: string): string => {
      const id = `table:cpp:-:${name}`;
      if (!tables.has(id)) {
        const node: GraphNode = { id, label: "Table", properties: { name, kind: "table", library: "sql", schemaName: null, provider: null, declaredIn: null, line: null, columns: "[]" } };
        tables.set(id, node);
        nodes.push(node);
      }
      return id;
    };
    const models = new Set<string>();
    const model = (name: string, library: string): string => {
      const id = `datamodel:${library}:${name}`;
      if (!models.has(id)) {
        models.add(id);
        nodes.push({ id, label: "DataModel", properties: { name, library } });
        relationships.push({ from: id, to: table(name), type: "MAPS_TO_TABLE", properties: {} });
      }
      return id;
    };

    const accesses: Access[] = [];
    const schema = new SqlSchema();
    let order = 0;
    for (const file of files) {
      const candidates = JSON.parse(String(file.properties.cppData)) as Candidate[];
      delete file.properties.cppData;
      const relativePath = String(file.properties.relativePath);
      for (const candidate of candidates) {
        if (/^\s*(?:CREATE|ALTER|DROP)\b/iu.test(candidate.sql)) {
          for (const statement of splitStatements(candidate.sql)) {
            try {
              schema.apply({ text: statement.text, line: candidate.line + statement.line - 1 }, relativePath, order);
            } catch {
              // A statement the reader cannot take is left out.
            }
          }
          order += 1;
          continue;
        }
        const found = sqlTableAccesses(candidate.sql).filter((access) => /^[A-Za-z_][\w$]*$/u.test(access.table));
        for (const access of found) {
          accesses.push({ owner: candidate.owner, extra: candidate.routes, modelId: model(access.table, candidate.library), operation: access.operation, library: candidate.library, line: candidate.line, expression: candidate.expression });
        }
      }
    }
    // Tables a `CREATE TABLE` string declares.
    for (const declared of schema.tables.values()) {
      const id = table(declared.name);
      const node = tables.get(id)!;
      Object.assign(node.properties, {
        kind: declared.kind,
        declaredIn: declared.file,
        line: declared.line,
        schemaName: declared.schemaName,
        columns: JSON.stringify(declared.columns.map((column) => ({
          name: column.name, column: column.name, type: column.type, optional: column.optional, list: false, isId: column.isId, isUnique: column.isUnique,
          ...(column.references ? { references: column.references } : {}),
        }))),
        migrations: JSON.stringify(declared.changes),
        indexes: JSON.stringify(declared.indexes),
      });
    }

    // ACCESSES_DATA from the function, its routes and entrypoints, and the
    // functions that call it.
    const callerByCall = new Map<string, string>();
    const routesByFunction = new Map<string, string[]>();
    const entrypointsByFunction = new Map<string, string[]>();
    const targetsByCall = new Map<string, string[]>();
    for (const rel of graph.relationships) {
      if (rel.type === "CALLS") callerByCall.set(rel.to, rel.from);
      else if (rel.type === "ROUTE_HANDLED_BY") routesByFunction.set(rel.to, [...routesByFunction.get(rel.to) ?? [], rel.from]);
      else if (rel.type === "ENTRYPOINT_HANDLED_BY") entrypointsByFunction.set(rel.to, [...entrypointsByFunction.get(rel.to) ?? [], rel.from]);
      else if (rel.type === "CALL_RESOLVES_TO") targetsByCall.set(rel.from, [...targetsByCall.get(rel.from) ?? [], rel.to]);
    }
    const filePaths = new Set(graph.nodes.flatMap((node) => (node.label === "File" && typeof node.properties.relativePath === "string" ? [node.properties.relativePath] : [])));
    const accessesByFunction = new Map<string, Access[]>();
    const seen = new Set<string>();
    const record = (from: string, access: Access, direct: boolean) => {
      const key = `${from}\0${access.modelId}\0${access.operation}\0${access.library}\0${access.line}\0${access.expression}`;
      if (seen.has(key)) return false;
      seen.add(key);
      relationships.push({
        from,
        to: access.modelId,
        type: "ACCESSES_DATA",
        properties: { operation: access.operation, library: access.library, line: access.line, expression: access.expression, file: fileOfNodeId(access.owner, filePaths), direct },
      });
      return true;
    };
    for (const access of accesses) {
      if (record(access.owner, access, true)) accessesByFunction.set(access.owner, [...accessesByFunction.get(access.owner) ?? [], access]);
      for (const source of [...access.extra, ...routesByFunction.get(access.owner) ?? [], ...entrypointsByFunction.get(access.owner) ?? []]) record(source, access, false);
    }
    const callersOf = new Map<string, string[]>();
    for (const [callId, targets] of targetsByCall) {
      const caller = callerByCall.get(callId);
      if (!caller) continue;
      for (const target of targets) if (target !== caller) callersOf.set(target, [...callersOf.get(target) ?? [], caller]);
    }
    const queue = [...accessesByFunction.keys()];
    while (queue.length > 0) {
      const functionId = queue.shift()!;
      for (const caller of callersOf.get(functionId) ?? []) {
        let changed = false;
        for (const access of accessesByFunction.get(functionId) ?? []) {
          if (!record(caller, access, false)) continue;
          accessesByFunction.set(caller, [...accessesByFunction.get(caller) ?? [], access]);
          for (const source of [...routesByFunction.get(caller) ?? [], ...entrypointsByFunction.get(caller) ?? []]) record(source, access, false);
          changed = true;
        }
        if (changed) queue.push(caller);
      }
    }

    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

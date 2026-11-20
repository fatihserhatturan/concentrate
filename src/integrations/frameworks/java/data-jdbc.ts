import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";
import { typeDeclarationTypes } from "../../languages/java/syntax.js";
import { javaDataModel, javaTable, normalizeTableName, recordJavaDataAccesses, sqlModelAccesses, type JavaDataAccess } from "./data-shared.js";
import { mybatisAccesses } from "./mybatis.js";
import { createJavaReceiverResolver, receiverMatches, type JavaReceiverType } from "./receivers.js";
import { javaMethods } from "./shared.js";
import { createJavaStringResolver, parseJavaString, readJavaString, readLocalStrings, serializeJavaString } from "./strings.js";

// Java JDBC and MyBatis data access (Phase 42, track B): the tables of the SQL a Java service runs, as
// ACCESSES_DATA from the function that runs it (library `jdbc`; `mybatis` for MyBatis), which `js-ts.data-access`
// turns into READS / WRITES; routes, entrypoints and callers get the access through `recordJavaDataAccesses`.
//
// JDBC. A parse plugin keeps, on each method that calls one of the methods below, the first argument of the call
// as a string template (`javaJdbcSql` on the Function: `[line, column, callee, template]`; literals, text
// blocks, concatenation, single-assignment locals; constants are `ref`s). The contributor then checks the
// receiver's declared type (`receivers.ts`), so an unrelated `query(...)` is ignored, resolves constants
// (`strings.ts`) and reads the tables with the SQL layer (`sqlModelAccesses`):
//   - Spring `JdbcTemplate` / `JdbcOperations` and `NamedParameterJdbcTemplate` / `...Operations`: `query`,
//     `queryForObject`, `queryForList`, `queryForMap`, `queryForRowSet`, `queryForStream`, `update`,
//     `batchUpdate`, `execute`;
//   - `JdbcClient.sql("…")` (the statement's SQL; the fluent calls after it add nothing);
//   - `SimpleJdbcInsert.withTableName("t")`: a `create` of the table;
//   - `java.sql.Connection.prepareStatement` / `prepareCall` and `Statement.executeQuery` / `executeUpdate` /
//     `executeLargeUpdate` / `execute` / `addBatch` (the SQL given to the `Statement`; `PreparedStatement`'s
//     own `execute*()` have none, the SQL came with `prepareStatement`).
// MyBatis: `mybatis.ts` (mapper annotations and mapper XML).
// Dynamic parts of a statement are unknown (`"… FROM " + table` names no table; the tables the literal text
// names still count); a SQL string that is wholly dynamic (a parameter, a method result) is skipped.
//
// Not handled: a receiver the declared types do not show (`dataSource.getConnection().prepareStatement(…)`,
// `getJdbcTemplate()` of `JdbcDaoSupport`, `var x = factory()`, an injected field of an untyped base), SQL
// loaded from a file or built by `StringBuilder` / `MessageFormat` / a method, `SimpleJdbcInsert` with
// `withSchemaName(…)` before `withTableName` (the chain's receiver is a call), `SimpleJdbcCall` and stored
// procedure names (`{call p(?)}` names no table), `JdbcTemplate` calls through a `PreparedStatementCreator`
// lambda whose SQL is the lambda's own `prepareStatement(sql)` call (that call is read), Spring `@Sql`
// scripts, and MyBatis `@*Provider` annotations, `@MapperScan`, `<include>` properties, `databaseId`.
//
// Bump `version` of the plugin when its parse output changes.

const JDBC_FILE = /java\.sql|org\.springframework\.jdbc/u;

const TEMPLATE_METHODS = new Set(["query", "queryForObject", "queryForList", "queryForMap", "queryForRowSet", "queryForStream", "update", "batchUpdate", "execute"]);
const STATEMENT_METHODS = new Set(["executeQuery", "executeUpdate", "executeLargeUpdate", "execute", "addBatch"]);
const CONNECTION_METHODS = new Set(["prepareStatement", "prepareCall"]);
const PLUGIN_METHODS = new Set([...TEMPLATE_METHODS, ...STATEMENT_METHODS, ...CONNECTION_METHODS, "sql", "withTableName"]);

const CORE = "org.springframework.jdbc.core";
const TEMPLATES = [`${CORE}.JdbcTemplate`, `${CORE}.JdbcOperations`, `${CORE}.namedparam.NamedParameterJdbcTemplate`, `${CORE}.namedparam.NamedParameterJdbcOperations`];
const CLIENTS = [`${CORE}.simple.JdbcClient`];
const INSERTS = [`${CORE}.simple.SimpleJdbcInsert`, `${CORE}.simple.SimpleJdbcInsertOperations`];
const CONNECTIONS = ["java.sql.Connection"];
const STATEMENTS = ["java.sql.Statement", "java.sql.PreparedStatement", "java.sql.CallableStatement"];

type Site = [line: number, column: number, callee: string, template: string];

// A method's own syntax: nested types and anonymous classes are other methods' business.
const isNested = (node: SyntaxNode): boolean => typeDeclarationTypes.has(node.type) || (node.type === "class_body" && node.parent?.type === "object_creation_expression");

const readSites: JavaParsePlugin = ({ root, functions }) => {
  if (!JDBC_FILE.test(root.text)) return;
  for (const { syntax, node } of functions) {
    const body = syntax.childForFieldName("body");
    if (!body) continue;
    let locals: ReturnType<typeof readLocalStrings> | null = null;
    const sites: Site[] = [];
    const stack: SyntaxNode[] = [body];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (isNested(current)) continue;
      if (current.type === "method_invocation") {
        const name = current.childForFieldName("name")?.text;
        const first = current.childForFieldName("arguments")?.namedChildren.find((child) => !child.type.endsWith("comment"));
        if (name && PLUGIN_METHODS.has(name) && first && current.childForFieldName("object")) {
          locals ??= readLocalStrings([body]);
          const template = readJavaString(first, { locals });
          if (template) sites.push([current.startPosition.row + 1, current.startPosition.column, name, serializeJavaString(template)]);
        }
      }
      for (const child of current.namedChildren) stack.push(child);
    }
    if (sites.length > 0) node.properties.javaJdbcSql = JSON.stringify(sites.sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  }
};

export const javaDataJdbcPlugin: JavaParsePlugin & { version: string } = Object.assign(readSites, { version: "1" });

// Whether the call `callee` on a receiver of this type is one that carries SQL.
function carriesSql(callee: string, type: JavaReceiverType | null): "sql" | "table" | null {
  if (!type) return null;
  if (TEMPLATE_METHODS.has(callee) && receiverMatches(type, TEMPLATES)) return "sql";
  if (callee === "sql" && receiverMatches(type, CLIENTS)) return "sql";
  if (callee === "withTableName" && receiverMatches(type, INSERTS)) return "table";
  if (CONNECTION_METHODS.has(callee) && receiverMatches(type, CONNECTIONS)) return "sql";
  if (STATEMENT_METHODS.has(callee) && receiverMatches(type, STATEMENTS)) return "sql";
  return null;
}

const identifier = /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*$/u;

export const javaDataJdbcContributor: ISemanticContributor = {
  id: "java.data-jdbc",
  async contribute(graph, rootPath, _report, files) {
    const accesses: JavaDataAccess[] = [];
    const functions = graph.nodesWithLabel("Function").filter((node) => typeof node.properties.javaJdbcSql === "string");
    if (functions.length > 0) {
      const receivers = createJavaReceiverResolver(graph);
      const strings = createJavaStringResolver(graph);
      const methods = new Map(javaMethods(graph).map((method) => [method.node.id, method]));
      const callsByFunction = new Map<string, Map<string, GraphNode>>();
      for (const rel of graph.relationshipsOfType("CALLS")) {
        const call = graph.node(rel.to);
        if (!call || call.label !== "Call" || call.properties.callKind !== "method") continue;
        if (!methods.has(rel.from) || typeof methods.get(rel.from)!.node.properties.javaJdbcSql !== "string") continue;
        let calls = callsByFunction.get(rel.from);
        if (!calls) callsByFunction.set(rel.from, calls = new Map());
        calls.set(`${String(call.properties.line)}:${String(call.properties.columnNumber)}`, call);
      }
      for (const fn of functions) {
        const sites = JSON.parse(String(fn.properties.javaJdbcSql)) as Site[];
        delete fn.properties.javaJdbcSql;
        const method = methods.get(fn.id);
        if (!method) continue;
        for (const [line, column, callee, serialized] of sites) {
          const call = callsByFunction.get(fn.id)?.get(`${line}:${column}`);
          const template = parseJavaString(serialized);
          if (!call || !template) continue;
          const kind = carriesSql(callee, receivers.typeOfCall(call, fn));
          if (!kind) continue;
          const text = strings.resolve(template, { fileId: method.fileId, typeId: method.owner.id });
          if (text === null) continue;
          const expression = call.properties.expression;
          if (kind === "table") {
            const name = normalizeTableName(text.trim());
            if (!identifier.test(name)) continue;
            const table = javaTable(graph, name, { library: "jdbc" });
            const model = javaDataModel(graph, { name: String(graph.node(table)?.properties.name ?? name), library: "jdbc", table });
            accesses.push({ callId: call.id, modelId: model, operation: "create", library: "jdbc", line: call.properties.line, expression });
            continue;
          }
          for (const access of sqlModelAccesses(graph, text, "jdbc")) {
            accesses.push({ callId: call.id, modelId: access.modelId, operation: access.operation, library: "jdbc", line: call.properties.line, expression });
          }
        }
      }
    }
    accesses.push(...await mybatisAccesses(graph, rootPath, files));
    recordJavaDataAccesses(graph, accesses);
  },
};

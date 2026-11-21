import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";
import { typeDeclarationTypes } from "../../languages/java/syntax.js";
import { javaTable, javaTableModel, normalizeTableName, recordJavaDataAccesses, sqlModelAccesses, type JavaDataAccess } from "./data-shared.js";
import { mybatisAccesses } from "./mybatis.js";
import { createJavaReceiverResolver, receiverMatches, type JavaReceiverType } from "./receivers.js";
import { javaMethods } from "./shared.js";
import { createJavaStringResolver, javaLocalNames, parseJavaString, readJavaString, readLocalStrings, serializeJavaString, type JavaStringScope } from "./strings.js";

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
//     `batchUpdate` (every `String` argument of `batchUpdate(String...)`), `execute`;
//   - `JdbcClient.sql("…")` (the statement's SQL; the fluent calls after it add nothing);
//   - `SimpleJdbcInsert.withTableName("t")` (`new SimpleJdbcInsert(ds).withSchemaName("s").withTableName("t")` too:
//     the receiver of `withTableName` is typed by the chain's start) only configures the insert. The `create` of
//     the table is made where the insert runs: `execute` / `executeAndReturnKey` / `executeBatch`, on the chain
//     itself, or on the field (or local) the configured insert was assigned to, in a constructor, an initializer
//     or the same method (`javaJdbcInserts` on the Function, `javaJdbcInsertTable` on the Field);
//   - `java.sql.Connection.prepareStatement` / `prepareCall` and `Statement.executeQuery` / `executeUpdate` /
//     `executeLargeUpdate` / `execute` / `addBatch` (the SQL given to the `Statement`; `PreparedStatement`'s
//     own `execute*()` have none, the SQL came with `prepareStatement`).
// MyBatis: `mybatis.ts` (mapper annotations and mapper XML).
// Dynamic parts of a statement are unknown (`"… FROM " + table` names no table; the tables the literal text
// names still count); a SQL string that is wholly dynamic (a parameter, a method result) is skipped.
//
// Not handled: a receiver the declared types do not show (`dataSource.getConnection().prepareStatement(…)`,
// `getJdbcTemplate()` of `JdbcDaoSupport`, `var x = factory()`, an injected field of an untyped base), SQL
// loaded from a file or built by `StringBuilder` / `MessageFormat` / a method, `SimpleJdbcCall` and stored
// procedure names (`{call p(?)}` names no table), `JdbcTemplate` calls through a `PreparedStatementCreator`
// lambda whose SQL is the lambda's own `prepareStatement(sql)` call (that call is read), Spring `@Sql`
// scripts, and MyBatis `@*Provider` annotations, `@MapperScan`, `<include>` properties, `databaseId`.
//
// Bump `version` of the plugin when its parse output changes.

const JDBC_FILE = /java\.sql|org\.springframework\.jdbc/u;

const TEMPLATE_METHODS = new Set(["query", "queryForObject", "queryForList", "queryForMap", "queryForRowSet", "queryForStream", "update", "batchUpdate", "execute"]);
const STATEMENT_METHODS = new Set(["executeQuery", "executeUpdate", "executeLargeUpdate", "execute", "addBatch"]);
const CONNECTION_METHODS = new Set(["prepareStatement", "prepareCall"]);
const INSERT_RUNS = new Set(["execute", "executeAndReturnKey", "executeBatch"]);
const PLUGIN_METHODS = new Set([...TEMPLATE_METHODS, ...STATEMENT_METHODS, ...CONNECTION_METHODS, "sql", "withTableName"]);

const CORE = "org.springframework.jdbc.core";
const TEMPLATES = [`${CORE}.JdbcTemplate`, `${CORE}.JdbcOperations`, `${CORE}.namedparam.NamedParameterJdbcTemplate`, `${CORE}.namedparam.NamedParameterJdbcOperations`];
const CLIENTS = [`${CORE}.simple.JdbcClient`];
const INSERTS = [`${CORE}.simple.SimpleJdbcInsert`, `${CORE}.simple.SimpleJdbcInsertOperations`];
const CONNECTIONS = ["java.sql.Connection"];
const STATEMENTS = ["java.sql.Statement", "java.sql.PreparedStatement", "java.sql.CallableStatement"];

// `binding`: "run" when the chain itself runs the insert, `bind:<name>` when it is assigned to a field or local.
type Site = [line: number, column: number, callee: string, template: string, binding?: string];
// An `execute*` call on a plain name: [line, column, callee, receiver text].
type InsertRun = [line: number, column: number, callee: string, receiver: string];

// Where the chain that `invocation` starts goes: it runs the insert itself, or is assigned to a field or local.
function chainBinding(invocation: SyntaxNode): string {
  let top = invocation;
  while (top.parent?.type === "method_invocation" && top.parent.childForFieldName("object")?.id === top.id) top = top.parent;
  if (top.id !== invocation.id && INSERT_RUNS.has(top.childForFieldName("name")?.text ?? "")) return "run";
  const parent = top.parent;
  if (parent?.type === "variable_declarator" && parent.childForFieldName("value")?.id === top.id) return `bind:${parent.childForFieldName("name")?.text ?? ""}`;
  if (parent?.type === "assignment_expression" && parent.childForFieldName("right")?.id === top.id) {
    const left = parent.childForFieldName("left");
    if (left?.type === "identifier") return `bind:${left.text}`;
    if (left?.type === "field_access" && left.childForFieldName("object")?.type === "this") return `bind:${left.childForFieldName("field")?.text ?? ""}`;
  }
  return "";
}

// A method's own syntax: nested types and anonymous classes are other methods' business.
const isNested = (node: SyntaxNode): boolean => typeDeclarationTypes.has(node.type) || (node.type === "class_body" && node.parent?.type === "object_creation_expression");

// `private final SimpleJdbcInsert insert = new SimpleJdbcInsert(ds).withTableName("t");` keeps the table's string
// template on the Field.
function readInsertFields(fileNodeId: string, root: SyntaxNode, nodes: GraphNode[]): void {
  const fields = new Map<string, GraphNode>();
  for (const node of nodes) if (node.label === "Field" && node.id.startsWith(`${fileNodeId}:`)) fields.set(`${node.properties.line}:${node.properties.name}`, node);
  if (fields.size === 0) return;
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    for (const child of node.namedChildren) stack.push(child);
    if (node.type !== "field_declaration") continue;
    for (const declarator of node.childrenForFieldName("declarator")) {
      const name = declarator.childForFieldName("name")?.text;
      const field = name ? fields.get(`${declarator.startPosition.row + 1}:${name}`) : undefined;
      let chain = declarator.childForFieldName("value");
      while (field && chain?.type === "method_invocation") {
        if (chain.childForFieldName("name")?.text === "withTableName") {
          const arg = chain.childForFieldName("arguments")?.namedChildren.find((child) => !child.type.endsWith("comment"));
          const template = arg ? readJavaString(arg) : null;
          if (template) field.properties.javaJdbcInsertTable = serializeJavaString(template);
          break;
        }
        chain = chain.childForFieldName("object");
      }
    }
  }
}

const readSites: JavaParsePlugin = ({ fileNodeId, root, nodes, functions }) => {
  if (!JDBC_FILE.test(root.text)) return;
  readInsertFields(fileNodeId, root, nodes);
  for (const { syntax, node } of functions) {
    const body = syntax.childForFieldName("body");
    if (!body) continue;
    let scope: JavaStringScope | null = null;
    const sites: Site[] = [];
    const runs: InsertRun[] = [];
    const stack: SyntaxNode[] = [body];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (isNested(current)) continue;
      if (current.type === "method_invocation") {
        const name = current.childForFieldName("name")?.text;
        const args = current.childForFieldName("arguments")?.namedChildren.filter((child) => !child.type.endsWith("comment")) ?? [];
        const first = args[0];
        if (name && PLUGIN_METHODS.has(name) && first && current.childForFieldName("object")) {
          if (!scope) {
            const dynamic = javaLocalNames([body]);
            scope = { locals: readLocalStrings([body], dynamic), dynamic };
          }
          // `batchUpdate(String... sql)` carries SQL in every argument; the others only in the first.
          for (const arg of name === "batchUpdate" ? args : [first]) {
            const template = readJavaString(arg, scope);
            if (!template) continue;
            const site: Site = [current.startPosition.row + 1, current.startPosition.column, name, serializeJavaString(template)];
            if (name === "withTableName") site.push(chainBinding(current));
            sites.push(site);
          }
        }
        const object = current.childForFieldName("object");
        if (name && INSERT_RUNS.has(name) && object && (object.type === "identifier" || object.type === "field_access")) {
          runs.push([current.startPosition.row + 1, current.startPosition.column, name, object.text]);
        }
      }
      for (const child of current.namedChildren) stack.push(child);
    }
    if (sites.length > 0) node.properties.javaJdbcSql = JSON.stringify(sites.sort((a, b) => a[0] - b[0] || a[1] - b[1]));
    if (runs.length > 0) node.properties.javaJdbcInserts = JSON.stringify(runs.sort((a, b) => a[0] - b[0] || a[1] - b[1]));
  }
};

export const javaDataJdbcPlugin: JavaParsePlugin & { version: string } = Object.assign(readSites, { version: "3" });

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
    const functions = graph.nodesWithLabel("Function").filter((node) => typeof node.properties.javaJdbcSql === "string" || typeof node.properties.javaJdbcInserts === "string");
    const insertFields = graph.nodesWithLabel("Field").filter((node) => typeof node.properties.javaJdbcInsertTable === "string");
    if (functions.length > 0 || insertFields.length > 0) {
      const receivers = createJavaReceiverResolver(graph);
      const strings = createJavaStringResolver(graph);
      const methods = new Map(javaMethods(graph).map((method) => [method.node.id, method]));
      const functionIds = new Set(functions.map((fn) => fn.id));
      const callsByFunction = new Map<string, Map<string, GraphNode>>();
      for (const rel of graph.relationshipsOfType("CALLS")) {
        const call = graph.node(rel.to);
        if (!call || call.label !== "Call" || call.properties.callKind !== "method") continue;
        if (!methods.has(rel.from) || !functionIds.has(rel.from)) continue;
        let calls = callsByFunction.get(rel.from);
        if (!calls) callsByFunction.set(rel.from, calls = new Map());
        calls.set(`${String(call.properties.line)}:${String(call.properties.columnNumber)}`, call);
      }
      // The table each configured `SimpleJdbcInsert` field or local names: `<owner type or method id>:<name>`.
      const insertTables = new Map<string, string[]>();
      const addInsertTable = (key: string, model: string): void => {
        const known = insertTables.get(key) ?? [];
        if (!known.includes(model)) insertTables.set(key, [...known, model]);
      };
      const tableModel = (text: string): string | null => {
        const name = normalizeTableName(text.trim());
        return identifier.test(name) ? javaTableModel(graph, javaTable(graph, name, { library: "jdbc" }), "jdbc") : null;
      };
      const typeOfField = new Map<string, string>();
      for (const rel of graph.relationshipsOfType("DEFINES_FIELD")) typeOfField.set(rel.to, rel.from);
      for (const field of insertFields) {
        const template = parseJavaString(String(field.properties.javaJdbcInsertTable));
        delete field.properties.javaJdbcInsertTable;
        const typeId = typeOfField.get(field.id);
        const fileId = typeId ? [...methods.values()].find((method) => method.owner.id === typeId)?.fileId : undefined;
        if (!template || !typeId || !fileId) continue;
        const text = strings.resolve(template, { fileId, typeId });
        const model = text === null ? null : tableModel(text);
        if (model) addInsertTable(`${typeId}:${String(field.properties.name)}`, model);
      }
      const sitesOf = new Map<string, Site[]>();
      for (const fn of functions) {
        if (typeof fn.properties.javaJdbcSql !== "string") continue;
        sitesOf.set(fn.id, JSON.parse(fn.properties.javaJdbcSql) as Site[]);
        delete fn.properties.javaJdbcSql;
      }
      for (const fn of functions) {
        const method = methods.get(fn.id);
        if (!method) continue;
        for (const [line, column, callee, serialized, binding] of sitesOf.get(fn.id) ?? []) {
          const call = callsByFunction.get(fn.id)?.get(`${line}:${column}`);
          const template = parseJavaString(serialized);
          if (!call || !template) continue;
          const kind = carriesSql(callee, receivers.typeOfCall(call, fn));
          if (!kind) continue;
          const text = strings.resolve(template, { fileId: method.fileId, typeId: method.owner.id });
          if (text === null) continue;
          const expression = call.properties.expression;
          if (kind === "table") {
            // Configuring the insert is no access: the table is created where the insert runs.
            const model = tableModel(text);
            if (!model) continue;
            if (binding === "run") accesses.push({ callId: call.id, modelId: model, operation: "create", library: "jdbc", line: call.properties.line, expression });
            else if (binding?.startsWith("bind:")) {
              const name = binding.slice("bind:".length);
              addInsertTable(`${method.owner.id}:${name}`, model);
              addInsertTable(`${fn.id}:${name}`, model);
            }
            continue;
          }
          for (const access of sqlModelAccesses(graph, text, "jdbc")) {
            accesses.push({ callId: call.id, modelId: access.modelId, operation: access.operation, library: "jdbc", line: call.properties.line, expression });
          }
        }
      }
      // The insert runs: `insert.execute(...)` on a field or local that was configured with a table.
      for (const fn of functions) {
        if (typeof fn.properties.javaJdbcInserts !== "string") continue;
        const runs = JSON.parse(fn.properties.javaJdbcInserts) as InsertRun[];
        delete fn.properties.javaJdbcInserts;
        const method = methods.get(fn.id);
        if (!method) continue;
        for (const [line, column, callee, receiver] of runs) {
          const call = callsByFunction.get(fn.id)?.get(`${line}:${column}`);
          if (!call || call.properties.callee !== callee || !receiverMatches(receivers.typeOfCall(call, fn), INSERTS)) continue;
          const name = receiver.startsWith("this.") ? receiver.slice("this.".length) : receiver;
          if (!identifier.test(name) || name.includes(".")) continue;
          const tables = insertTables.get(`${fn.id}:${name}`) ?? insertTables.get(`${method.owner.id}:${name}`) ?? [];
          for (const modelId of tables) accesses.push({ callId: call.id, modelId, operation: "create", library: "jdbc", line: call.properties.line, expression: call.properties.expression });
        }
      }
    }
    accesses.push(...await mybatisAccesses(graph, rootPath, files));
    recordJavaDataAccesses(graph, accesses);
  },
};

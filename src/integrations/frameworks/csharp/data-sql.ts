import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { GraphSchemaExtension } from "../../../core/graph/schema.js";
import type { VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import { csharpSqlModelAccesses, csharpTable, csharpTableModel, recordCSharpDataAccesses, type CSharpDataAccess } from "./data-shared.js";
import { invocationInfo } from "./invocations.js";
import { createCSharpReceiverResolver, receiverMatches, type CSharpReceiverResolver } from "./receivers.js";
import { createCSharpStringResolver, parseCSharpString, readCSharpString, serializeCSharpString, stringScopeOf, type CSharpStringScope } from "./strings.js";

// C# Dapper and ADO.NET data access (Phase 47, track B), after Java's `data-jdbc.ts`: the tables of the SQL a service
// runs, as ACCESSES_DATA from the function that runs it (library `dapper` or `ado.net`; `js-ts.data-access` turns them
// into READS / WRITES, routes, entrypoints and callers get them through `recordCSharpDataAccesses`). The tables come
// from the shared SQL layer (`csharpSqlModelAccesses`, stand-in DataModel `datamodel:<library>:<table>` per table).
//
// A parse plugin keeps the SQL expression of each site as a string template (`strings.ts`: literals, verbatim, raw and
// interpolated strings, concatenation, single-assignment locals; constants stay `ref`s) in a PRIVATE property
// (`csharpSqlSite` on the Call, `csharpSqlAssigns` on the Function) that the contributor removes. The contributor
// checks the receiver's type (`receivers.ts`) so an unrelated `Query(...)` is ignored, resolves constants and reads
// the tables.
//
// Dapper: `Query`, `Query<T>`, `QueryAsync`, `QueryFirst|QueryFirstOrDefault|QuerySingle|QuerySingleOrDefault(+Async)`,
// `QueryMultiple(+Async)`, `Execute(+Async)`, `ExecuteScalar(+Async)`, `ExecuteReader(+Async)` on a receiver typed
// `IDbConnection` / `DbConnection` / `SqlConnection` / `NpgsqlConnection` / `MySqlConnection` / `SqliteConnection` /
// `OracleConnection` / ... (a local, parameter, field, property, primary-constructor parameter, `new X(..)`, or a local
// initialised by a `Create|Open|Get...Connection(...)` factory call). The SQL is the first argument, or `sql:` /
// `commandText:`. `new CommandDefinition(sql, ...)` (inline or in a local) carries the SQL of its first argument.
// ADO.NET: `new SqlCommand|NpgsqlCommand|MySqlCommand|SqliteCommand|SQLiteCommand|OracleCommand|OleDbCommand|OdbcCommand|
// FbCommand|DbCommand-derived(sql, conn)` and `new SqlDataAdapter(sql, conn)`-like adapters (argument 0 or `cmdText:` /
// `selectCommandText:`), the object initializer `new X { CommandText = ... }`, the assignment `cmd.CommandText = ...` on a
// receiver typed as a command (or `IDbCommand`), and on a local initialised by `conn.CreateCommand()` where `conn` is
// typed as a connection. The access is made by the function that constructs / assigns. `SqlBulkCopy.DestinationTableName
// = "t"` is a `create` of `t`.
// A stored procedure names no table: `CommandType.StoredProcedure` in the call's arguments (Dapper) or anywhere in the
// same function (ADO.NET) skips the site.
//
// Dynamic parts of a statement are unknown (`"... FROM " + table` names no table; the tables the literal text names
// still count); a SQL string that is wholly dynamic (a parameter, a method result) is skipped, never guessed.
//
// Not handled: SQL read from files / resources, `StringBuilder`, `string.Create`, `DbCommandBuilder`, stored procedure
// names, Dapper.Contrib (`Get`, `Insert`), `MERGE` (the shared SQL layer does not read it), a receiver whose type the
// declared types do not show (`(await GetConnection()).Query(..)`, `factory.Create().Query(..)`), a command passed in
// from another method (`ExecuteReader` on a parameter has no SQL: the SQL is where the command was built).
//
// Bump `version` of the plugin when its parse output changes.

const DAPPER_METHODS = new Set(
  [
    "Query", "QueryFirst", "QueryFirstOrDefault", "QuerySingle", "QuerySingleOrDefault", "QueryMultiple", "Execute", "ExecuteScalar", "ExecuteReader",
  ].flatMap((name) => [name, `${name}Async`]),
);
const COMMAND_TYPES = ["SqlCommand", "NpgsqlCommand", "MySqlCommand", "SqliteCommand", "SQLiteCommand", "OracleCommand", "OleDbCommand", "OdbcCommand", "FbCommand", "DB2Command", "DbCommand"];
const ADAPTER_TYPES = ["SqlDataAdapter", "NpgsqlDataAdapter", "MySqlDataAdapter", "SQLiteDataAdapter", "OracleDataAdapter", "OleDbDataAdapter", "OdbcDataAdapter", "FbDataAdapter", "DbDataAdapter"];
const ASSIGN_COMMAND_TYPES = [...COMMAND_TYPES, "IDbCommand"];
const CONNECTION_TYPES = ["IDbConnection", "DbConnection", "SqlConnection", "NpgsqlConnection", "MySqlConnection", "SqliteConnection", "SQLiteConnection", "OracleConnection", "OleDbConnection", "OdbcConnection", "FbConnection", "DB2Connection"];
const BULK_TYPES = ["SqlBulkCopy", "MySqlBulkCopy"];
const NEW_TYPES = new Set([...COMMAND_TYPES, ...ADAPTER_TYPES, "CommandDefinition"]);
const FILE_GATE = /\b(?:Query|Execute)\w*\s*[<(]|Command|DataAdapter|BulkCopy/u;
const STORED_PROCEDURE = /\bStoredProcedure\b/u;
const CONNECTION_FACTORY = /(?:Create|Open|Get)\w*Connection\w*\(/u;
const TABLE_NAME = /^[A-Za-z_][\w$]*(?:\.[A-Za-z_][\w$]*)*$|^(?:\[[^\]]+\]|"[^"]+"|`[^`]+`)(?:\.(?:\[[^\]]+\]|"[^"]+"|`[^`]+`|[A-Za-z_][\w$]*))*$/u;

// `kind`: "dapper" (a Dapper call), "new" (a `new X(sql, ...)`), type text `ty` for "new".
type Site = { k: "dapper" | "new"; t: string; ty?: string };
// An assignment `receiver.Member = value`: [line, member, receiver text, template].
type Assign = [line: number, member: string, receiver: string, template: string];

const lastName = (text: string): string => text.replace(/<.*$/u, "").split(".").at(-1)!.trim();
const isInitializerAssign = (node: SyntaxNode): boolean => node.parent?.type === "initializer_expression";
const SKIPPED = new Set([
  "class_declaration", "struct_declaration", "record_declaration", "record_struct_declaration", "interface_declaration", "enum_declaration",
  "namespace_declaration", "file_scoped_namespace_declaration", "method_declaration", "constructor_declaration", "destructor_declaration",
  "operator_declaration", "conversion_operator_declaration", "property_declaration", "indexer_declaration", "event_declaration", "accessor_declaration",
]);

// What a member's own syntax holds: assignments `x.CommandText = ...` / `x.DestinationTableName = ...`, and whether it
// names `CommandType.StoredProcedure`. Nested type and member declarations are other members' business.
function readMember(root: SyntaxNode): { assigns: Array<{ line: number; member: string; receiver: string; value: SyntaxNode }>; storedProcedure: boolean } {
  const assigns: Array<{ line: number; member: string; receiver: string; value: SyntaxNode }> = [];
  let storedProcedure = false;
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.id !== root.id && SKIPPED.has(node.type)) continue;
    if (node.type === "member_access_expression" && STORED_PROCEDURE.test(node.text) && /CommandType\s*\.\s*StoredProcedure$/u.test(node.text)) storedProcedure = true;
    if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      const operator = node.children.find((child) => !child.isNamed && child.text.endsWith("="));
      if (left?.type === "member_access_expression" && right && operator?.text === "=") {
        const member = left.childForFieldName("name")?.text;
        const receiver = left.childForFieldName("expression")?.text;
        if ((member === "CommandText" || member === "DestinationTableName") && receiver) assigns.push({ line: node.startPosition.row + 1, member, receiver, value: right });
      }
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  return { assigns, storedProcedure };
}

const readSites: VersionedCSharpParsePlugin = ({ root, functions, calls }) => {
  if (!FILE_GATE.test(root.text)) return;
  const members = new Map<string, { syntax: SyntaxNode; node: GraphNode; storedProcedure: boolean }>();
  const scopes = new Map<string, Required<CSharpStringScope>>();
  const scopeOf = (id: string): Required<CSharpStringScope> => {
    let scope = scopes.get(id);
    if (!scope) scopes.set(id, (scope = stringScopeOf(members.get(id)!)));
    return scope;
  };
  for (const member of functions) {
    const { assigns, storedProcedure } = readMember(member.syntax);
    members.set(member.node.id, { ...member, storedProcedure });
    if (assigns.length === 0) continue;
    const kept: Assign[] = [];
    for (const assign of assigns) {
      if (assign.member === "CommandText" && storedProcedure) continue;
      const template = readCSharpString(assign.value, scopeOf(member.node.id));
      if (template) kept.push([assign.line, assign.member, assign.receiver.replace(/\s+/gu, ""), serializeCSharpString(template)]);
    }
    if (kept.length > 0) member.node.properties.csharpSqlAssigns = JSON.stringify(kept);
  }
  for (const call of calls) {
    const member = members.get(call.function.id);
    if (!member) continue;
    if (call.syntax.type === "invocation_expression") {
      const info = invocationInfo(call.syntax);
      if (!info || !info.receiver || !DAPPER_METHODS.has(info.name)) continue;
      if (info.arguments.some((arg) => STORED_PROCEDURE.test(arg.text))) continue;
      const arg = info.arguments.find((candidate) => candidate.name === "sql" || candidate.name === "commandText") ?? info.arguments.find((candidate) => candidate.name === null);
      // `new CommandDefinition(sql, ...)`: its own site.
      if (!arg || arg.node.type === "object_creation_expression" || arg.node.type === "implicit_object_creation_expression") continue;
      const template = readCSharpString(arg.node, scopeOf(call.function.id));
      if (template) call.node.properties.csharpSqlSite = JSON.stringify({ k: "dapper", t: serializeCSharpString(template) } satisfies Site);
      continue;
    }
    if (call.syntax.type !== "object_creation_expression") continue;
    const typeNode = call.syntax.childForFieldName("type");
    const ty = typeNode ? lastName(typeNode.text) : "";
    if (!NEW_TYPES.has(ty)) continue;
    const list = call.syntax.childForFieldName("arguments") ?? call.syntax.namedChildren.find((child) => child.type === "argument_list") ?? null;
    const args = (list?.namedChildren ?? []).filter((child) => child.type === "argument");
    const argText = args.map((arg) => arg.text).join(",");
    if (STORED_PROCEDURE.test(argText) || (ty !== "CommandDefinition" && member.storedProcedure)) continue;
    let expression: SyntaxNode | null = null;
    const named = args.find((arg) => /^(?:cmdText|commandText|selectCommandText|selectCommand)\s*:/u.test(arg.text));
    const target = named ?? args.find((arg) => !arg.namedChildren.some((child) => child.type === "name_colon"));
    if (target) expression = target.namedChildren.filter((child) => child.type !== "name_colon" && child.type !== "comment").at(-1) ?? null;
    // `new SqlCommand { CommandText = "..." }`
    const initializer = call.syntax.namedChildren.find((child) => child.type === "initializer_expression");
    for (const item of initializer?.namedChildren ?? []) {
      if (item.type !== "assignment_expression" || !isInitializerAssign(item)) continue;
      if (item.childForFieldName("left")?.text === "CommandText") expression = item.childForFieldName("right") ?? expression;
    }
    if (!expression) continue;
    const template = readCSharpString(expression, scopeOf(call.function.id));
    if (template) call.node.properties.csharpSqlSite = JSON.stringify({ k: "new", t: serializeCSharpString(template), ty } satisfies Site);
  }
};

export const csharpDataSqlPlugin: VersionedCSharpParsePlugin = Object.assign(readSites, { version: "1" });

function isConnection(text: string, fn: GraphNode, receivers: CSharpReceiverResolver): boolean {
  if (receiverMatches(receivers.typeOf(text, fn), CONNECTION_TYPES, receivers)) return true;
  // `var conn = factory.CreateConnection();`: the factory's name says it returns a connection.
  const initializer = receivers.initializerOf(text, fn);
  return initializer !== null && CONNECTION_FACTORY.test(initializer);
}

export const csharpDataSqlContributor: ISemanticContributor = {
  id: "csharp.data-sql",
  contribute(graph) {
    const calls = graph.nodesWithLabel("Call").filter((node) => typeof node.properties.csharpSqlSite === "string");
    const functions = graph.nodesWithLabel("Function").filter((node) => typeof node.properties.csharpSqlAssigns === "string");
    if (calls.length === 0 && functions.length === 0) return;
    const receivers = createCSharpReceiverResolver(graph);
    const strings = createCSharpStringResolver(graph);
    const accesses: CSharpDataAccess[] = [];
    const addSql = (target: { callId: string } | { functionId: string }, node: GraphNode, template: string, library: string, line: unknown, expression: unknown): void => {
      const parsed = parseCSharpString(template);
      const sql = parsed ? strings.resolveAt(parsed, node) : null;
      if (sql === null) return;
      for (const access of csharpSqlModelAccesses(graph, sql, library)) accesses.push({ ...target, modelId: access.modelId, operation: access.operation, library, line, expression });
    };

    for (const call of calls) {
      const site = JSON.parse(String(call.properties.csharpSqlSite)) as Site;
      delete call.properties.csharpSqlSite;
      const fn = receivers.functionOf(call);
      if (!fn) continue;
      const expression = call.properties.expression;
      if (site.k === "dapper") {
        const receiver = call.properties.receiver;
        if (typeof receiver !== "string" || !isConnection(receiver, fn, receivers)) continue;
        addSql({ callId: call.id }, call, site.t, "dapper", call.properties.line, expression);
        continue;
      }
      const ty = site.ty ?? "";
      const named = receivers.typeOf(`new ${ty}()`, fn);
      if (ty === "CommandDefinition") {
        if (named?.type) continue;
        addSql({ callId: call.id }, call, site.t, "dapper", call.properties.line, expression);
      } else if (receiverMatches(named, [...COMMAND_TYPES, ...ADAPTER_TYPES], receivers)) addSql({ callId: call.id }, call, site.t, "ado.net", call.properties.line, expression);
    }

    for (const fn of functions) {
      const assigns = JSON.parse(String(fn.properties.csharpSqlAssigns)) as Assign[];
      delete fn.properties.csharpSqlAssigns;
      for (const [line, member, receiver, template] of assigns) {
        if (member === "DestinationTableName") {
          if (!receiverMatches(receivers.typeOf(receiver, fn), BULK_TYPES, receivers)) continue;
          const parsed = parseCSharpString(template);
          const name = parsed ? strings.resolveAt(parsed, fn)?.trim() ?? null : null;
          if (!name || !TABLE_NAME.test(name)) continue;
          const modelId = csharpTableModel(graph, csharpTable(graph, name, { library: "ado.net" }), "ado.net");
          accesses.push({ functionId: fn.id, modelId, operation: "create", library: "ado.net", line, expression: `${receiver}.DestinationTableName` });
          continue;
        }
        let isCommand = receiverMatches(receivers.typeOf(receiver, fn), ASSIGN_COMMAND_TYPES, receivers);
        if (!isCommand) {
          // `var cmd = conn.CreateCommand();` with `conn` typed as a connection.
          const initializer = receivers.initializerOf(receiver, fn);
          const match = initializer ? /^(.+)\.CreateCommand\(\)$/u.exec(initializer.replace(/\s+/gu, "")) : null;
          isCommand = match !== null && receiverMatches(receivers.typeOf(match[1], fn), CONNECTION_TYPES, receivers);
        }
        if (isCommand) addSql({ functionId: fn.id }, fn, template, "ado.net", line, `${receiver}.CommandText`);
      }
    }
    recordCSharpDataAccesses(graph, accesses);
  },
};

// Graph schema additions of this track: none (the output uses existing nodes and properties).
export const csharpDataSqlSchema: GraphSchemaExtension = { id: "csharp-data-sql" };

import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { GraphSchemaExtension } from "../../../core/graph/schema.js";
import type { VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";
import { compactNoSpace, normalizeCSharpType, plainName, trailingGenericArguments } from "../../languages/csharp/syntax.js";
import type { CSharpType } from "../../languages/csharp/types.js";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import { csharpAttributeReader, findAttributes, namedArgument, positionalArguments, type CSharpAttributeInfo } from "./attributes.js";
import { csharpDataModel, csharpSqlModelAccesses, csharpTable, recordCSharpDataAccesses, type CSharpDataAccess, type CSharpDataOperation } from "./data-shared.js";
import { descendantsOfType, dottedText, invocationChain, invocationInfo, lambdaInfo, type InvocationInfo } from "./invocations.js";
import { createCSharpReceiverResolver, receiverMatches, type CSharpPosition, type CSharpReceiverType } from "./receivers.js";
import { parametersOf } from "./shared.js";
import {
  createCSharpStringResolver,
  csharpStringFromText,
  hasLiteralText,
  literalText,
  parseCSharpString,
  readCSharpString,
  renderCSharpString,
  serializeCSharpString,
  stringScopeOf,
  type CSharpStringTemplate,
} from "./strings.js";

// EF Core (library `efcore`) as Java's `data-jpa.ts` reads JPA: a DbContext's `DbSet<T>` makes the entity T a DataModel
// mapped to a Table, and the code that goes through a DbSet or the context's raw SQL ACCESSES_DATA.
//
// DbContext: a scanned class with a base `DbContext`, `IdentityDbContext<...>` (or another `Identity*Context`) outside
// the scan, directly or through scanned classes. Entities are the T of its `DbSet<T>` properties (own and inherited
// from a scanned context), plus the T of `modelBuilder.Entity<T>()` in a model configuration.
//
// Table name, in order: `ToTable("x"[, "schema"])` of `OnModelCreating` (`modelBuilder.Entity<T>().ToTable(..)`, inside
// `Entity<T>(e => { e.ToTable(..) })`, or `IEntityTypeConfiguration<T>.Configure(builder)` with `builder.ToTable(..)`),
// then `[Table("x", Schema = "s")]`, then the convention: the name of the DbSet PROPERTY (`DbSet<User> AppUsers` is
// `AppUsers`), else the entity class name (EF Core's pluralisation of the class name is not applied). A `[NotMapped]`
// entity and `modelBuilder.Ignore<T>()` make no DataModel and no Table. The Table's `columns` (name, column, type,
// optional, list, isId, isUnique) come from the entity's scalar properties (its scanned base classes' too): `[Column]` /
// `HasColumnName` name the column, `[Key]` / `HasKey` (else `Id` / `<Entity>Id`) the key, `[Required]` / `IsRequired` /
// a non-nullable type the not-optional ones; `[NotMapped]` properties, navigations (a scanned class, a collection) and
// static members are left out. `optional` is true for a nullable type (`int?`, `string?`) only: whether `string` is
// required depends on the nullable context, which is not read.
//
// ACCESSES_DATA (from the function that makes the access, and, `direct: false`, from its routes and callers; recorded
// with `recordCSharpDataAccesses`): the first method applied to a DbSet (`db.Orders.Where(..).ToListAsync()`,
// `_db.Orders.Add(x)`, `db.Set<Order>().ExecuteDelete()`), a `from x in db.Orders` / `join` clause and a
// `foreach (var o in db.Orders)`. `operation`: `create` for Add*, `update` for Update*, Attach*, ExecuteUpdate*, `delete`
// for Remove*, ExecuteDelete*, `aggregate` for Count / LongCount / Sum / Min / Max / Average (any step of the chain),
// else `read` (queries, Find, First*, Any, ToList...); the first write method of the chain decides. EFCore.BulkExtensions
// (`BulkInsert`, `BulkUpdate`, `BulkDelete`, `BulkInsertOrUpdate`, `BulkMerge`) are read the same way. `expression` is
// the written access (`_db.Orders.Add`), `line` the line of the DbSet expression. The receiver must be typed as the
// user's DbContext: a field, property, parameter, primary-constructor parameter, `this.x`, a local created with `new X()`
// (`using var ctx = new BillingContext()`), `var ctx = factory.CreateDbContext()` of an `IDbContextFactory<X>`, or the
// context's own members (`Orders.Add(..)`, `this.Orders`, `Set<T>()` inside the DbContext subclass). A List<T> named
// `Orders`, or a non-DbContext `DbSet`-like property, gives nothing.
//
// Raw SQL: `Database.ExecuteSqlRaw|ExecuteSqlInterpolated|ExecuteSql(Async)`, `Database.SqlQuery<T>` / `SqlQueryRaw<T>` and
// `db.Orders.FromSqlRaw|FromSqlInterpolated|FromSql(..)`: the SQL (literal, verbatim, raw, interpolated, concatenation,
// `const`, single-assignment local) is read by the shared SQL layer and each table it names is an ACCESSES_DATA to the
// library's table-named stand-in DataModel (`datamodel:efcore:<table>`) with the operation of the SQL, not of the method.
// A `FromSql*` on a DbSet whose SQL names no table (a stored procedure) reads the DbSet's entity; a dynamic string or
// `Execute*` without a table gives nothing.
//
// Review fixes: a navigation link before `ToTable` (`OwnsOne(..).ToTable("x")`, `HasOne`, `Navigation`) does not rename the
// owner; only public properties (or `[Column]` / `HasColumnName` ones) are columns, never expression-bodied, computed or
// get-only-without-initializer ones; `IsRequired(false)` makes a column optional; an interface that declares `DbSet<T>` and
// is implemented by a scanned context is that context; `_context.Add(x)` / `Update` / `Remove` / `Attach` (+ `Range`) and
// `Find<T>` on the context map by the argument's static type (or the type argument) and give nothing when it is not an
// entity; the chain is read up to its materialization (`ToList()`, `First*`, ...): `db.Orders.ToList().Add(x)` is a read.
//
// Not handled: compiled models, owned types, TPH / TPT / TPC inheritance beyond the base entity's own table, many-to-many
// join tables (`UsingEntity`), `ToView`, value converters, a DbContext known only through DI (the receiver type must be
// visible), `Set(typeof(T))`, `Entry(x)` (ignored), a DbSet stored in a variable (`var set = db.Orders; set.Add(x)`) or
// returned, `ApplyConfigurationsFromAssembly` (the configuration classes are read wherever they are written), `MERGE`.
//
// EF Core's external calls have no Call node (their target is not in the scan), so the parse plugin keeps what the
// contributor needs on the enclosing Function node as the private properties `csharpEfAccesses` and `csharpEfConfig`;
// the contributor removes both.

const ACCESSES = "csharpEfAccesses";
const CONFIG = "csharpEfConfig";
const LIBRARY = "efcore";
const CONTEXT_NAMES = ["DbContext", "IdentityDbContext", "IdentityUserContext"];
const FACTORY_NAMES = ["IDbContextFactory"];

// Method names (without the `Async` suffix) after a DbSet that count as an access, and the operation each one means.
const READS = new Set([
  "Where", "Select", "SelectMany", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending", "Include", "ThenInclude", "AsNoTracking",
  "AsNoTrackingWithIdentityResolution", "AsTracking", "AsSplitQuery", "AsSingleQuery", "IgnoreQueryFilters", "IgnoreAutoIncludes", "TagWith",
  "AsQueryable", "AsEnumerable", "AsAsyncEnumerable", "Skip", "SkipWhile", "Take", "TakeWhile", "Distinct", "GroupBy", "GroupJoin", "Join", "Reverse",
  "Union", "Concat", "Except", "Intersect", "Cast", "OfType", "First", "FirstOrDefault", "Last", "LastOrDefault", "Single", "SingleOrDefault",
  "ElementAt", "ElementAtOrDefault", "DefaultIfEmpty", "Any", "All", "Contains", "ToList", "ToArray", "ToDictionary", "ToHashSet", "ToLookup", "Find",
  "Load", "ForEach", "ToQueryString", "Zip", "Chunk",
]);
const AGGREGATES = new Set(["Count", "LongCount", "Sum", "Min", "Max", "Average", "MinBy", "MaxBy"]);
const WRITES = new Map<string, CSharpDataOperation>([
  ["Add", "create"], ["AddRange", "create"], ["BulkInsert", "create"],
  ["Update", "update"], ["UpdateRange", "update"], ["ExecuteUpdate", "update"], ["Attach", "update"], ["AttachRange", "update"], ["BulkUpdate", "update"],
  ["Remove", "delete"], ["RemoveRange", "delete"], ["ExecuteDelete", "delete"], ["BulkDelete", "delete"],
  ["AddOrUpdate", "upsert"], ["Upsert", "upsert"], ["BulkInsertOrUpdate", "upsert"], ["BulkMerge", "upsert"],
]);
// Methods of the DbContext itself that name their entity by an argument (`_context.Add(order)`) or a type argument (`Find<Order>(id)`).
const CONTEXT_METHODS = new Set(["Add", "AddRange", "Update", "UpdateRange", "Remove", "RemoveRange", "Attach", "AttachRange", "Find"]);
// A step that ends the query: what follows works on the materialized result (`db.Orders.ToList().Add(x)` is a read).
const MATERIALIZERS = new Set([
  "ToList", "ToArray", "ToDictionary", "ToHashSet", "ToLookup", "AsEnumerable", "AsAsyncEnumerable", "First", "FirstOrDefault", "Last", "LastOrDefault", "Single",
  "SingleOrDefault", "ElementAt", "ElementAtOrDefault", "Find", "Any", "All", "Contains", "ToQueryString", "Load", "ForEach",
]);
const SET_SQL = new Set(["FromSqlRaw", "FromSqlInterpolated", "FromSql"]);
const DATABASE_SQL = new Set(["ExecuteSqlRaw", "ExecuteSqlInterpolated", "ExecuteSql", "SqlQuery", "SqlQueryRaw"]);
const TRIGGERS = new Set([...READS, ...AGGREGATES, ...WRITES.keys(), ...SET_SQL, ...DATABASE_SQL]);

const stripAsync = (name: string): string => (name.endsWith("Async") && name.length > 5 ? name.slice(0, -5) : name);

// Syntax that starts a member of its own (its Function has its own entry): not part of the function being read.
const BOUNDARIES = new Set([
  "class_declaration", "struct_declaration", "record_declaration", "record_struct_declaration", "interface_declaration", "enum_declaration",
  "method_declaration", "constructor_declaration", "destructor_declaration", "operator_declaration", "conversion_operator_declaration",
  "property_declaration", "indexer_declaration", "accessor_declaration", "field_declaration", "event_declaration", "event_field_declaration",
  "namespace_declaration", "file_scoped_namespace_declaration",
]);

function walk(root: SyntaxNode, visit: (node: SyntaxNode) => void): void {
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    visit(node);
    const children = node.namedChildren;
    for (let i = children.length - 1; i >= 0; i -= 1) {
      const child = children[i]!;
      if (!BOUNDARIES.has(child.type)) stack.push(child);
    }
  }
}

// ---------------------------------------------------------------- parse time

/** One DbSet-or-context access site as the plugin keeps it: `r` receiver text, `m` member (the DbSet property, `Database`), `t` the T of `Set<T>()`, `c` method chain, `l` line, `e` expression, `s` serialized SQL. */
type AccessRecord = {
  r: string; m: string | null; t: string | null; c: string[]; l: number; e: string; s?: string;
  /** Column of the access (0-based), to tell lambdas of one line apart. */
  k?: number;
  /** `ctx`: a method of the context itself (`_context.Add(x)`, `Find<T>(..)`); `x`: the text of its first argument. */
  ctx?: true;
  x?: string;
};
type TableRecord = { e: string; n: string; s?: string; l: number };
type PropertyRecord = { e: string; p: string; c?: string; required?: boolean; key?: true };
type ConfigRecord = { entities: string[]; ignored: string[]; tables: TableRecord[]; props: PropertyRecord[] };

type Candidate = { r: string; m: string | null; t: string | null; text: string };

function unwrap(node: SyntaxNode | null): SyntaxNode | null {
  let current = node;
  while (current?.type === "parenthesized_expression") current = current.namedChildren.find((child) => child.type !== "comment") ?? null;
  return current;
}

// A DbSet-like expression: `db.Orders`, `Orders`, `this.Orders`, `db.Database`, `db.Set<Order>()`, `Set<Order>()`.
function candidateOf(expression: SyntaxNode | null): Candidate | null {
  const node = unwrap(expression);
  if (!node) return null;
  if (node.type === "identifier") {
    const name = plainName(node.text);
    return { r: "", m: name, t: null, text: name };
  }
  if (node.type === "member_access_expression") {
    const name = node.childForFieldName("name");
    if (name?.type !== "identifier") return null;
    const receiver = dottedText(node.childForFieldName("expression"));
    if (receiver === null) return null;
    const member = plainName(name.text);
    return { r: receiver, m: member, t: null, text: `${receiver}.${member}` };
  }
  if (node.type === "invocation_expression") {
    const info = invocationInfo(node);
    if (!info || info.name !== "Set" || info.typeArguments.length !== 1 || info.arguments.length > 1) return null;
    const receiver = info.receiver ? dottedText(info.receiver) : "";
    if (receiver === null) return null;
    const generic = compactNoSpace(info.typeArguments[0]!);
    return { r: receiver, m: null, t: generic, text: `${receiver === "" ? "" : `${receiver}.`}Set<${generic}>()` };
  }
  return null;
}

// The method name of the member access that continues `node` as `.Name(...)`, with the invocation it belongs to.
function continuation(node: SyntaxNode): { name: string; call: SyntaxNode } | null {
  const access = node.parent;
  if (access?.type !== "member_access_expression" || access.childForFieldName("expression")?.id !== node.id) return null;
  const call = access.parent;
  if (call?.type !== "invocation_expression" || call.childForFieldName("function")?.id !== access.id) return null;
  const info = invocationInfo(call);
  return info ? { name: info.name, call } : null;
}

const functionReturnsDbSet = (node: { properties: GraphNode["properties"] }): boolean => /^DbSet\b/u.test(String(node.properties.returnType ?? ""));

const sourceOfClause = (clause: SyntaxNode): SyntaxNode | null => {
  const children = clause.children;
  const at = children.findIndex((child) => child.type === "in");
  if (at === -1) return null;
  return children.slice(at + 1).find((child) => child.isNamed && child.type !== "comment") ?? null;
};

function readAccesses(member: { syntax: SyntaxNode; node: GraphNode }): AccessRecord[] {
  const records: AccessRecord[] = [];
  let scope: ReturnType<typeof stringScopeOf> | undefined;
  const push = (candidate: Candidate, chain: string[], expression: string, line: number, column: number, sql?: InvocationInfo, extra?: Partial<AccessRecord>): void => {
    if (candidate.m === null && candidate.t === null && !extra?.ctx) return;
    const record: AccessRecord = { r: candidate.r, m: candidate.m, t: candidate.t, c: chain, l: line, e: expression, k: column, ...extra };
    if (sql) {
      const argument = sql.arguments.find((item) => item.name?.toLowerCase() === "sql") ?? sql.arguments.find((item) => item.name === null);
      scope ??= stringScopeOf(member);
      const template = argument ? readCSharpString(argument.node, scope) : null;
      if (template) record.s = serializeCSharpString(template);
    }
    records.push(record);
  };
  walk(member.syntax, (node) => {
    if (node.type === "invocation_expression") {
      const info = invocationInfo(node);
      if (!info?.receiver || !TRIGGERS.has(stripAsync(info.name))) return;
      const chain = [info.name];
      for (let next = continuation(node); next; next = continuation(next.call)) chain.push(next.name);
      const line = node.startPosition.row + 1;
      const column = node.startPosition.column;
      // `_context.Add(order)` / `_context.Find<Order>(id)`: the context itself, the entity is named by the argument.
      if (CONTEXT_METHODS.has(stripAsync(info.name))) {
        const receiverText = dottedText(unwrap(info.receiver));
        if (receiverText !== null) {
          const first = info.arguments.find((argument) => argument.name === null) ?? info.arguments[0];
          const generic = info.typeArguments.length === 1 ? compactNoSpace(info.typeArguments[0]!) : null;
          push({ r: receiverText, m: null, t: generic, text: receiverText }, chain, `${receiverText}.${info.name}`, line, column, undefined, {
            ctx: true,
            ...(first ? { x: compactNoSpace(first.text).slice(0, 200) } : {}),
          });
        }
      }
      const candidate = candidateOf(info.receiver);
      if (!candidate) return;
      const raw = SET_SQL.has(info.name) || DATABASE_SQL.has(stripAsync(info.name)) ? info : undefined;
      push(candidate, chain, `${candidate.text}.${info.name}`, line, column, raw);
    } else if (node.type === "from_clause" || node.type === "join_clause") {
      const candidate = candidateOf(sourceOfClause(node));
      if (candidate) push(candidate, ["__query"], candidate.text, node.startPosition.row + 1, node.startPosition.column);
    } else if (node.type === "for_each_statement") {
      const candidate = candidateOf(node.childForFieldName("right"));
      if (candidate) push(candidate, ["__foreach"], candidate.text, node.startPosition.row + 1, node.startPosition.column);
    }
  });
  return records;
}

const NAVIGATIONS = new Set(["OwnsOne", "OwnsMany", "HasOne", "HasMany", "Navigation", "WithOne", "WithMany", "UsingEntity"]);

const propertyOfLambda = (text: string): string | null => /=>\s*(?:[\w.?!]*\.)?(\w+)\s*$/u.exec(text)?.[1] ?? null;

function readConfig(member: { syntax: SyntaxNode; node: GraphNode }): ConfigRecord | null {
  const parameters = parametersOf(member.node);
  const configuring =
    member.node.properties.name === "OnModelCreating" ||
    member.node.properties.name === "Configure" ||
    parameters.some((parameter) => /(?:^|[.\s])(?:ModelBuilder|EntityTypeBuilder)\b/u.test(parameter.type));
  if (!configuring) return null;
  const config: ConfigRecord = { entities: [], ignored: [], tables: [], props: [] };
  let scope: ReturnType<typeof stringScopeOf> | undefined;
  const template = (node: SyntaxNode): string | null => {
    scope ??= stringScopeOf(member);
    const read = readCSharpString(node, scope);
    return read ? serializeCSharpString(read) : null;
  };
  const entityOf = (call: SyntaxNode): string | null => {
    const { root, chain } = invocationChain(call);
    // `Entity<T>().OwnsOne(o => o.Addr).ToTable("x")`: what follows a navigation link configures the related / owned type.
    for (const link of chain.slice(0, -1)) if (NAVIGATIONS.has(link.name)) return null;
    for (const link of chain) if (link.name === "Entity" && link.typeArguments.length === 1) return compactNoSpace(link.typeArguments[0]!);
    const rootText = dottedText(root);
    if (!rootText) return null;
    for (let parent = call.parent; parent; parent = parent.parent) {
      if (parent.type !== "lambda_expression") continue;
      const owner = parent.parent?.parent?.parent;
      const lambda = lambdaInfo(parent);
      if (owner?.type !== "invocation_expression" || !lambda) continue;
      const info = invocationInfo(owner);
      if (info?.name === "Entity" && info.typeArguments.length === 1 && lambda.parameters[0]?.name === rootText) return compactNoSpace(info.typeArguments[0]!);
    }
    const parameter = parameters.find((candidate) => candidate.name === rootText);
    const generic = parameter ? trailingGenericArguments(parameter.type)?.[0] : undefined;
    return generic && /EntityTypeBuilder/u.test(parameter!.type) ? compactNoSpace(generic) : null;
  };
  const propertyOf = (call: SyntaxNode): string | null => {
    for (const link of invocationChain(call).chain) {
      if (link.name !== "Property") continue;
      const argument = link.arguments[0];
      if (!argument) return null;
      return argument.kind === "string" ? argument.value ?? null : propertyOfLambda(argument.text);
    }
    return null;
  };
  for (const call of descendantsOfType(member.syntax, new Set(["invocation_expression"]))) {
    const info = invocationInfo(call);
    if (!info) continue;
    if (info.name === "Entity" && info.typeArguments.length === 1) config.entities.push(compactNoSpace(info.typeArguments[0]!));
    else if (info.name === "Ignore" && info.typeArguments.length === 1 && info.arguments.length === 0) config.ignored.push(compactNoSpace(info.typeArguments[0]!));
    else if (info.name === "ToTable") {
      const entity = entityOf(call);
      const named = (name: string) => info.arguments.find((argument) => argument.name === name && argument.kind !== "lambda");
      const positional = info.arguments.filter((argument) => argument.name === null && argument.kind !== "lambda");
      const nameArgument = named("name") ?? positional[0];
      const schemaArgument = named("schema") ?? (positional[0] === nameArgument ? positional[1] : positional[0]);
      const name = nameArgument ? template(nameArgument.node) : null;
      if (entity && name) {
        const schema = schemaArgument ? template(schemaArgument.node) : null;
        config.tables.push({ e: entity, n: name, ...(schema ? { s: schema } : {}), l: call.startPosition.row + 1 });
      }
    } else if (info.name === "HasColumnName" || info.name === "IsRequired" || info.name === "HasKey") {
      const entity = entityOf(call);
      if (!entity) continue;
      if (info.name === "HasKey") {
        const body = info.arguments[0]?.text ?? "";
        for (const match of body.slice(body.indexOf("=>") + 2).matchAll(/\b\w+\.(\w+)/gu)) config.props.push({ e: entity, p: match[1]!, key: true });
        continue;
      }
      const property = propertyOf(call);
      if (!property) continue;
      if (info.name === "HasColumnName") {
        const column = info.arguments[0] ? template(info.arguments[0].node) : null;
        if (column) config.props.push({ e: entity, p: property, c: column });
      } else config.props.push({ e: entity, p: property, required: info.arguments[0]?.text !== "false" });
    }
  }
  return config.entities.length + config.ignored.length + config.tables.length + config.props.length === 0 ? null : config;
}

// A property EF Core does not map: expression-bodied or computed (a getter body and no setter), or get-only without initializer.
const UNMAPPED = "csharpEfUnmapped";
const TYPE_DECLARATIONS = new Set(["class_declaration", "struct_declaration", "record_declaration", "record_struct_declaration"]);

function markUnmappedProperties(types: readonly { syntax: SyntaxNode }[], nodes: readonly GraphNode[]): void {
  let fields: Map<string, GraphNode> | undefined;
  for (const { syntax } of types) {
    if (!TYPE_DECLARATIONS.has(syntax.type)) continue;
    const body = syntax.childForFieldName("body") ?? syntax.namedChildren.find((child) => child.type === "declaration_list");
    for (const member of body?.namedChildren ?? []) {
      if (member.type !== "property_declaration") continue;
      const name = plainName(member.childForFieldName("name")?.text ?? "");
      const value = member.childForFieldName("value");
      const accessors = (member.childForFieldName("accessors")?.namedChildren ?? []).filter((accessor) => accessor.type === "accessor_declaration");
      const names = accessors.map((accessor) => accessor.childForFieldName("name")?.text);
      const writable = names.includes("set") || names.includes("init");
      const hasBody = accessors.some((accessor) => accessor.childForFieldName("body") !== null);
      const arrow = value?.type === "arrow_expression_clause";
      const computed = !writable && (arrow || hasBody);
      const getOnlyWithoutInitializer = !writable && !arrow && !hasBody && value === null;
      if (!name || !(computed || getOnlyWithoutInitializer)) continue;
      const line = member.startPosition.row + 1;
      fields ??= new Map(nodes.filter((node) => node.label === "Field").map((node) => [`${String(node.properties.line)}:${String(node.properties.name)}`, node]));
      const field = fields.get(`${line}:${name}`);
      if (field) field.properties[UNMAPPED] = true;
    }
  }
}

const readEfCore: VersionedCSharpParsePlugin = ({ functions, types, nodes }) => {
  markUnmappedProperties(types, nodes);
  for (const member of functions) {
    if (functionReturnsDbSet(member.node)) continue;
    const accesses = readAccesses(member);
    if (accesses.length > 0) member.node.properties[ACCESSES] = JSON.stringify(accesses);
    const config = readConfig(member);
    if (config) member.node.properties[CONFIG] = JSON.stringify(config);
  }
};

export const csharpDataEfcorePlugin: VersionedCSharpParsePlugin = Object.assign(readEfCore, { version: "2" });

// ---------------------------------------------------------------- graph time

type Column = { name: string; column: string; type: string | null; optional: boolean; list: boolean; isId: boolean; isUnique: boolean };
type Entity = {
  key: string;
  name: string;
  type: CSharpType | null;
  /** First DbSet of the entity: the node it was found at and the property name. */
  dbSet: { field: GraphNode; property: string } | null;
  /** The scope node the entity name was written at (a Field or Function), for resolving names. */
  scopeNode: GraphNode;
};

const SCALAR_COLLECTIONS = new Set(["List", "IList", "ICollection", "IEnumerable", "HashSet", "ISet", "IReadOnlyList", "IReadOnlyCollection", "Collection", "LinkedList"]);

const parseJson = <T>(value: unknown): T | null => {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
};

export const csharpDataEfcoreContributor: ISemanticContributor = {
  id: "csharp.data-efcore",
  contribute(graph) {
    const functions = graph.nodesWithLabel("Function");
    const withFacts = functions.filter((node) => node.properties[ACCESSES] !== undefined || node.properties[CONFIG] !== undefined);
    try {
      if (withFacts.length > 0) contributeEfCore(graph, withFacts);
    } finally {
      for (const node of functions) {
        delete node.properties[ACCESSES];
        delete node.properties[CONFIG];
      }
      for (const node of graph.nodesWithLabel("Field")) delete node.properties[UNMAPPED];
    }
  },
};

function contributeEfCore(graph: IGraphContributor,withFacts: GraphNode[]): void {
  const receivers = createCSharpReceiverResolver(graph);
  const resolver = receivers.types;
  const strings = createCSharpStringResolver(graph);
  const attributes = csharpAttributeReader(graph);
  const ordered = (nodes: readonly GraphNode[]) => [...nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const fieldsOf = new Map<string, GraphNode[]>();
  for (const rel of graph.relationshipsOfType("DEFINES_FIELD" as GraphRelationship["type"])) {
    const field = graph.node(rel.to);
    if (!field) continue;
    const list = fieldsOf.get(rel.from);
    if (list) list.push(field);
    else fieldsOf.set(rel.from, [field]);
  }

  const interfaceFieldsOf = new Map<string, GraphNode[]>();
  for (const rel of graph.relationshipsOfType("DEFINES_INTERFACE_FIELD" as GraphRelationship["type"])) {
    const field = graph.node(rel.to);
    if (!field) continue;
    const list = interfaceFieldsOf.get(rel.from);
    if (list) list.push(field);
    else interfaceFieldsOf.set(rel.from, [field]);
  }

  const relativeOf = (fileId: string | undefined): string | null => {
    const node = fileId ? graph.node(fileId) : undefined;
    return typeof node?.properties.relativePath === "string" ? node.properties.relativePath : null;
  };
  const stringArgument = (expression: string | null, node: GraphNode): string | null => {
    if (expression === null) return null;
    const template = csharpStringFromText(expression);
    return template ? literalText(strings.resolvePartsAt(template, node)) : null;
  };
  const resolvedText = (serialized: string | undefined, node: GraphNode): string | null => {
    const template = parseCSharpString(serialized);
    return template ? literalText(strings.resolvePartsAt(template, node)) : null;
  };

  // DbContexts of the scan.
  const contexts = ordered(resolver.index.types.filter((type) => type.node.label === "Class" && type.kind === "class" && resolver.derivesFromExternal(type, CONTEXT_NAMES)).map((type) => type.node)).map((node) => resolver.typeOf(node)!);
  const contextIds = new Set(contexts.map((type) => type.id));
  // An interface that declares `DbSet<T>` properties and is implemented by a scanned DbContext (`IAppDbContext`) stands for that context.
  const implementedByContext = new Set<string>();
  for (const context of contexts) {
    const stack = [context];
    while (stack.length > 0) {
      const current = stack.pop()!;
      for (const parent of resolver.index.supertypes(current)) {
        if (implementedByContext.has(parent.id)) continue;
        implementedByContext.add(parent.id);
        stack.push(parent);
      }
    }
  }
  const interfaceContexts = ordered(
    resolver.index.types.filter((type) => type.node.label === "Interface" && implementedByContext.has(type.id) && (interfaceFieldsOf.get(type.id) ?? []).some((field) => isDbSetProperty(field))).map((type) => type.node),
  ).map((node) => resolver.typeOf(node)!);
  for (const type of interfaceContexts) contextIds.add(type.id);

  const entityKeyOf = (written: string, scopeNode: GraphNode): { key: string; type: CSharpType | null } => {
    const type = resolver.resolve(written, scopeNode);
    return type ? { key: type.id, type } : { key: `?${normalizeCSharpType(written) ?? written}`, type: null };
  };
  const simpleName = (written: string): string => (normalizeCSharpType(written) ?? written).split(".").at(-1)!;

  function isDbSetProperty(field: GraphNode): boolean {
    return field.properties.fieldKind === "property" && field.properties.isStatic !== true && normalizeCSharpType(String(field.properties.declaredType ?? ""))?.split(".").at(-1) === "DbSet";
  }

  // Entities: the T of every DbSet<T> property, then the T of `Entity<T>()`.
  const entities = new Map<string, Entity>();
  const dbSetsOf = new Map<string, Map<string, string>>(); // context id -> DbSet property name -> entity key (own and inherited)
  for (const context of contexts) {
    const own = new Map<string, string>();
    for (const field of fieldsOf.get(context.id) ?? []) {
      if (field.properties.fieldKind !== "property" || field.properties.isStatic === true) continue;
      const declared = String(field.properties.declaredType ?? "");
      if (normalizeCSharpType(declared)?.split(".").at(-1) !== "DbSet") continue;
      const generic = trailingGenericArguments(declared);
      if (!generic || generic.length !== 1) continue;
      const { key, type } = entityKeyOf(generic[0]!, field);
      own.set(String(field.properties.name), key);
      if (!entities.has(key)) entities.set(key, { key, name: type?.name ?? simpleName(generic[0]!), type, dbSet: { field, property: String(field.properties.name) }, scopeNode: field });
    }
    dbSetsOf.set(context.id, own);
  }
  for (const context of interfaceContexts) {
    const own = new Map<string, string>();
    for (const field of interfaceFieldsOf.get(context.id) ?? []) {
      if (!isDbSetProperty(field)) continue;
      const generic = trailingGenericArguments(String(field.properties.declaredType ?? ""));
      if (generic?.length === 1) own.set(String(field.properties.name), entityKeyOf(generic[0]!, field).key);
    }
    dbSetsOf.set(context.id, own);
  }
  const allDbSets = (context: CSharpType): Map<string, string> => {
    const merged = new Map<string, string>();
    const seen = new Set<string>();
    const visit = (type: CSharpType): void => {
      if (seen.has(type.id)) return;
      seen.add(type.id);
      for (const [name, key] of dbSetsOf.get(type.id) ?? []) if (!merged.has(name)) merged.set(name, key);
      for (const parent of resolver.index.supertypes(type)) visit(parent);
    };
    visit(context);
    return merged;
  };

  // Model configuration: ToTable, column names, keys, ignored entities.
  const tableConfig = new Map<string, { name: string; schema: string | null }>();
  const propertyConfig = new Map<string, { column?: string; required?: boolean; key?: true }>(); // `${entity key}\0${property}`
  const ignored = new Set<string>();
  for (const fn of ordered(withFacts)) {
    const config = parseJson<ConfigRecord>(fn.properties[CONFIG]);
    if (!config) continue;
    for (const written of config.entities) {
      const { key, type } = entityKeyOf(written, fn);
      if (!entities.has(key)) entities.set(key, { key, name: type?.name ?? simpleName(written), type, dbSet: null, scopeNode: fn });
    }
    for (const written of config.ignored) ignored.add(entityKeyOf(written, fn).key);
    for (const table of config.tables) {
      const key = entityKeyOf(table.e, fn).key;
      const name = resolvedText(table.n, fn);
      if (!name || tableConfig.has(key)) continue;
      tableConfig.set(key, { name, schema: table.s ? resolvedText(table.s, fn) : null });
    }
    for (const property of config.props) {
      const key = `${entityKeyOf(property.e, fn).key}\0${property.p}`;
      const entry = propertyConfig.get(key) ?? {};
      if (property.c) entry.column ??= resolvedText(property.c, fn) ?? undefined;
      if (property.required !== undefined) entry.required = property.required;
      if (property.key) entry.key = true;
      propertyConfig.set(key, entry);
    }
  }

  // The scalar properties of an entity, base classes first.
  const classChain = (type: CSharpType): CSharpType[] => {
    const chain: CSharpType[] = [];
    const seen = new Set<string>();
    for (let current: CSharpType | undefined = type; current && !seen.has(current.id); current = resolver.index.supertypes(current).find((parent) => parent.node.label === "Class" && parent.kind === "class")) {
      seen.add(current.id);
      chain.unshift(current);
    }
    return chain;
  };
  const columnsOf = (entity: Entity): Column[] => {
    if (!entity.type) return [];
    type Candidate = { field: GraphNode; owner: CSharpType; list: CSharpAttributeInfo[] };
    const candidates: Candidate[] = [];
    for (const owner of classChain(entity.type)) {
      for (const field of fieldsOf.get(owner.id) ?? []) {
        if (field.properties.fieldKind !== "property" || field.properties.isStatic === true || field.properties[UNMAPPED] === true) continue;
        const list = attributes.attributesOf(field);
        // Only public properties are mapped by convention; a non-public one needs `[Column]` or `HasColumnName`.
        if (field.properties.visibility !== "public" && findAttributes(list, "Column", ["System.ComponentModel.DataAnnotations"]).length === 0 && propertyConfig.get(`${entity.key}\0${String(field.properties.name)}`)?.column === undefined) continue;
        if (findAttributes(list, "NotMapped", ["System.ComponentModel.DataAnnotations"]).length > 0) continue;
        const declared = String(field.properties.declaredType ?? "");
        const normalized = normalizeCSharpType(declared);
        if (!normalized || SCALAR_COLLECTIONS.has(normalized.split(".").at(-1)!) || normalized.endsWith("[]") && normalized !== "byte[]") continue;
        const resolved = resolver.resolve(declared, field);
        if (resolved && resolved.kind !== "enum") continue; // a navigation or an owned type
        candidates.push({ field, owner, list });
      }
    }
    const keyed = (candidate: Candidate): boolean =>
      findAttributes(candidate.list, "Key", ["System.ComponentModel.DataAnnotations"]).length > 0 || propertyConfig.get(`${entity.key}\0${String(candidate.field.properties.name)}`)?.key === true;
    const explicitKey = candidates.some(keyed);
    return candidates.map((candidate): Column => {
      const name = String(candidate.field.properties.name);
      const declared = String(candidate.field.properties.declaredType ?? "");
      const configured = propertyConfig.get(`${entity.key}\0${name}`);
      const columnAttribute = findAttributes(candidate.list, "Column", ["System.ComponentModel.DataAnnotations"])[0];
      const attributeName = columnAttribute ? stringArgument(positionalArguments(columnAttribute)[0] ?? null, candidate.field) : null;
      const lower = name.toLowerCase();
      const isId = explicitKey ? keyed(candidate) : lower === "id" || lower === `${entity.name.toLowerCase()}id`;
      const required = configured?.required !== undefined ? configured.required : findAttributes(candidate.list, "Required", ["System.ComponentModel.DataAnnotations"]).length > 0;
      return {
        name,
        column: configured?.column ?? attributeName ?? name,
        type: normalizeCSharpType(declared) ?? declared,
        optional: isId ? false : configured?.required === false ? true : required ? false : declared.trim().endsWith("?"),
        list: false,
        isId,
        isUnique: isId,
      };
    });
  };

  // Table and DataModel of each mapped entity.
  const modelOf = new Map<string, string>();
  for (const entity of [...entities.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    if (ignored.has(entity.key)) continue;
    if (entity.type && findAttributes(attributes.attributesOf(entity.type.node), "NotMapped", ["System.ComponentModel.DataAnnotations"]).length > 0) continue;
    let tableName: string | null = null;
    let schema: string | null = null;
    const configured = tableConfig.get(entity.key);
    if (configured) ({ name: tableName, schema } = configured);
    else if (entity.type) {
      const attribute = findAttributes(attributes.attributesOf(entity.type.node), "Table", ["System.ComponentModel.DataAnnotations"])[0];
      if (attribute) {
        // Constants are read at the entity's own scope (a Decorator node has no namespace of its own).
        tableName = stringArgument(positionalArguments(attribute)[0] ?? null, entity.type.node);
        schema = stringArgument(namedArgument(attribute, "Schema"), entity.type.node);
      }
    }
    tableName ??= entity.dbSet?.property ?? entity.name;
    const fileId = entity.type?.fileIds[0] ?? entity.dbSet?.field.id.replace(/:field:.*$/u, "");
    const declaredIn = relativeOf(fileId);
    const line = typeof entity.type?.node.properties.line === "number" ? entity.type.node.properties.line : Number(entity.scopeNode.properties.line ?? 0);
    const table = csharpTable(graph, tableName, { library: LIBRARY, schemaName: schema, declaredIn, line, columns: columnsOf(entity) });
    modelOf.set(entity.key, csharpDataModel(graph, { name: entity.name, library: LIBRARY, scope: entity.type?.namespace ?? "", declaredIn, line, table }));
  }

  // The context an access goes through, for a receiver text written in `fn`.
  const factoryContext = (text: string, fn: GraphNode): CSharpType | null => {
    const initializer = receivers.initializerOf(text, fn);
    const match = initializer ? /^(?:await\s+)?([\w.]+)\.CreateDbContext(?:Async)?\(/u.exec(initializer.trim()) : null;
    const factory = match ? receivers.typeOf(match[1], fn) : null;
    if (!factory || !FACTORY_NAMES.includes(factory.typeName.split(".").at(-1)!)) return null;
    const argument = factory.typeArguments[0];
    const type = argument ? resolver.resolve(argument, fn) : null;
    return type && contextIds.has(type.id) ? type : null;
  };
  type Through = { context: CSharpType | null; external: boolean };
  const contextOf = (receiver: string, fn: GraphNode, at?: CSharpPosition): Through | null => {
    if (receiver === "" || receiver === "this") {
      const owner = resolver.ownerOf(fn);
      const type = owner ? resolver.typeOf(owner) : undefined;
      return type && contextIds.has(type.id) ? { context: type, external: false } : null;
    }
    const type: CSharpReceiverType | null = receivers.typeOf(receiver, fn, at);
    if (type?.type && contextIds.has(type.type.id)) return { context: type.type, external: false };
    if (type && type.type === null && receiverMatches(type, CONTEXT_NAMES)) return { context: null, external: true };
    const made = factoryContext(receiver, fn);
    return made ? { context: made, external: false } : null;
  };

  // The chain is read up to the step that materializes the query: `db.Orders.ToList().Add(x)` adds to a list.
  const operationOf = (chain: readonly string[]): CSharpDataOperation => {
    let aggregate = false;
    for (const name of chain) {
      const plain = stripAsync(name);
      const write = WRITES.get(plain);
      if (write) return write;
      if (AGGREGATES.has(plain)) aggregate = true;
      if (aggregate || MATERIALIZERS.has(plain)) break;
    }
    return aggregate ? "aggregate" : "read";
  };

  const accesses: CSharpDataAccess[] = [];
  for (const fn of ordered(withFacts)) {
    const records = parseJson<AccessRecord[]>(fn.properties[ACCESSES]);
    if (!records) continue;
    for (const record of records) {
      const at: CSharpPosition = { line: record.l, ...(record.k !== undefined ? { column: record.k } : {}) };
      const through = contextOf(record.r, fn, at);
      if (!through) continue;
      let entityKey: string | null = null;
      let viaDatabase = false;
      if (record.ctx) {
        // `_context.Add(order)` / `Find<Order>(id)`: the entity of the argument's static type (or the type argument); else nothing.
        if (!through.context) continue;
        if (record.t !== null) entityKey = entityKeyOf(record.t, fn).key;
        else {
          const argument = record.x ? receivers.typeOf(record.x, fn, at) : null;
          const element = argument?.typeArguments.length === 1 ? resolver.resolve(argument.typeArguments[0]!, fn) : null;
          entityKey = argument?.type && entities.has(argument.type.id) ? argument.type.id : element && entities.has(element.id) ? element.id : null;
        }
      } else if (record.t !== null) entityKey = entityKeyOf(record.t, fn).key;
      else if (record.m === "Database") viaDatabase = true;
      else if (through.context && record.m !== null) entityKey = allDbSets(through.context).get(record.m) ?? null;
      if (!viaDatabase && (entityKey === null || !entities.has(entityKey))) continue;

      if (record.s !== undefined || viaDatabase) {
        const template: CSharpStringTemplate | null = parseCSharpString(record.s);
        const parts = template ? strings.resolvePartsAt(template, fn) : null;
        const sql = parts && hasLiteralText(parts) ? renderCSharpString(parts) : null;
        const found = sql ? csharpSqlModelAccesses(graph, sql, LIBRARY) : [];
        for (const access of found) accesses.push({ functionId: fn.id, modelId: access.modelId, operation: access.operation, library: LIBRARY, line: record.l, ...(record.k !== undefined ? { column: record.k } : {}), expression: record.e });
        if (found.length > 0 || viaDatabase) continue;
        // `FromSql*` naming no table (a stored procedure): the DbSet's entity is read.
      }
      const modelId = entityKey ? modelOf.get(entityKey) : undefined;
      if (!modelId) continue;
      accesses.push({ functionId: fn.id, modelId, operation: record.s !== undefined ? "read" : operationOf(record.c), library: LIBRARY, line: record.l, ...(record.k !== undefined ? { column: record.k } : {}), expression: record.e });
    }
  }
  recordCSharpDataAccesses(graph, accesses);
}

// Graph schema additions of this track: none (Table, DataModel and ACCESSES_DATA use existing properties only).
export const csharpDataEfcoreSchema: GraphSchemaExtension = { id: "csharp-data-efcore" };

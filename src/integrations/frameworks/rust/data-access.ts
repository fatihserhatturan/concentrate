import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { rustAttributesOf, type RustParsePlugin } from "../../languages/rust/parser.js";
import { fileOfNodeId } from "../js-ts/resolution/data-access.js";
import { sqlTableAccesses } from "../go/sql.js";

// Rust data access: sqlx, diesel and SeaORM.
//
// The parse records, per file, what the code declares (diesel `table!`
// macros and `joinable!`, diesel and FromRow model structs, SeaORM
// `DeriveEntityModel` entities and their `Relation` variants) and each call
// that reaches data (the literal SQL of sqlx, the diesel DSL's `users::table`
// under `insert_into` / `update` / `delete`, SeaORM's `Entity::find()` and
// `ActiveModel` writes) with the function it is in, on the File node. Once
// every file is parsed the contributor resolves them across files and makes:
//   - sqlx: `query!`, `query_as!`, `query_scalar!` (and `_unchecked`),
//     `sqlx::query(…)`, `query_as::<_, T>(…)`, `query_scalar` and
//     `QueryBuilder::new(…)` with literal SQL (or a same-file `const`): the
//     tables of the SQL, each a DataModel of library `sqlx` named by its
//     table; a `#[derive(FromRow)]` struct is a DataModel that `query_as`
//     maps to the table when the SQL touches exactly one.
//   - diesel: `table!` tables (columns kept), `#[derive(Queryable, Insertable,
//     …)]` structs with `#[diesel(table_name = users)]` as DataModels,
//     `belongs_to(User)` and `joinable!` as RELATES_TO; `users::table` /
//     `users::dsl::users` (and `users` where `users::dsl::*` is imported) is a
//     read, or the write of the `insert_into` / `update` / `delete` it is an
//     argument of (`replace_into` and `.on_conflict(…)` upsert).
//   - SeaORM: the entity module (`entity/user.rs` or `mod user`) with its
//     `table_name`, columns as fields, `has_many` / `has_one` / `belongs_to`
//     Relation variants as RELATES_TO; `user::Entity::find()`, `find_by_id`,
//     `insert`, `update_many`, `delete_many`, … (`use …::Entity as User`
//     aliases included) and `user::ActiveModel { … }.insert(db)` / `update` /
//     `save` / `delete`.
// The access is ACCESSES_DATA from the function, its routes and entrypoints
// and the functions that call it; READS / WRITES to the tables follow from
// the JS/TS data-access contributor, which runs after this one.

type Operation = "read" | "create" | "update" | "delete" | "upsert";
type Column = { name: string; column: string; type: string | null; optional: boolean; list: boolean; isId: boolean; isUnique: boolean };

type DieselTable = { ident: string; name: string; line: number; columns: Column[] };
type Model = { library: "diesel" | "sqlx"; name: string; line: number; tableIdent?: string; belongsTo: string[] };
type Entity = { module: string; table: string | null; line: number; columns: Column[]; relations: Array<{ field: string; module: string | null; kind: "one" | "many" }> };
type Candidate =
  | { kind: "sql"; owner: string; line: number; expression: string; sql: string; asType: string | null }
  | { kind: "diesel"; owner: string; line: number; expression: string; ident: string; operation: Operation }
  | { kind: "sea"; owner: string; line: number; expression: string; qualifier: string | null; operation: Operation };

type DistributiveOmit<T, K extends string> = T extends unknown ? Omit<T, K> : never;

type FileData = {
  tables: DieselTable[];
  joins: Array<{ child: string; parent: string; key: string | null }>;
  models: Model[];
  entities: Entity[];
  aliases: Array<{ alias: string; module: string }>;
  candidates: Candidate[];
};

const DERIVES = new Set(["Queryable", "Insertable", "AsChangeset", "Identifiable", "Selectable", "Associations", "QueryableByName"]);
const SEA_METHODS = new Map<string, Operation>([
  ["find", "read"], ["find_by_id", "read"], ["find_related", "read"],
  ["insert", "create"], ["insert_many", "create"],
  ["update", "update"], ["update_many", "update"],
  ["delete", "delete"], ["delete_many", "delete"], ["delete_by_id", "delete"],
]);
const ACTIVE_MODEL_METHODS = new Map<string, Operation>([["insert", "create"], ["update", "update"], ["save", "upsert"], ["delete", "delete"]]);
const DIESEL_ROOTS = new Map<string, Operation>([
  ["insert_into", "create"], ["insert_or_ignore_into", "create"], ["replace_into", "upsert"], ["update", "update"], ["delete", "delete"],
]);

export const rustDataAccessPlugin: RustParsePlugin = ({ fileNodeId, relativePath, root, nodes, functions }) => {
  const source = root.text;
  if (!/\bsqlx\b|\bdiesel\b|\bsea_orm\b|\bDeriveEntityModel\b|\bEntity\s+as\b/u.test(source)) return;
  if (/(^|[\\/])tests[\\/]/u.test(relativePath)) return;

  const owners = functions
    .filter((fn) => typeof fn.node.properties.line === "number" && typeof fn.node.properties.endLine === "number")
    .map((fn) => ({ id: fn.node.id, line: Number(fn.node.properties.line), endLine: Number(fn.node.properties.endLine) }));
  const ownerOf = (line: number) => owners
    .filter((owner) => owner.line <= line && line <= owner.endLine)
    .sort((left, right) => (left.endLine - left.line) - (right.endLine - right.line))[0]?.id ?? null;

  const constants = new Map<string, string>();
  for (const item of root.descendantsOfType("const_item").concat(root.descendantsOfType("static_item"))) {
    const name = item.childForFieldName("name")?.text;
    const value = item.childForFieldName("value");
    const literal = value ? stringLiteral(value, new Map()) : null;
    if (name && literal !== null) constants.set(name, literal);
  }

  const data: FileData = { tables: [], joins: [], models: [], entities: [], aliases: [], candidates: [] };
  const hasSqlx = /\bsqlx\b/u.test(source);
  const bareSqlx = /\buse\s+sqlx::(?:\{[^}]*\b(?:query|query_as|query_scalar)\b|(?:query|query_as|query_scalar)\b)/u.test(source);
  const module = moduleName(root, relativePath);
  const dslImports = [...source.matchAll(/\buse\s+(?:[\w:]+::)?(\w+)::dsl::(?:\*|(\w+)|\{([^}]*)\})/gu)]
    .flatMap((match) => match[1] ? [match[1]] : []);
  const sqlLine = (node: SyntaxNode) => node.startPosition.row + 1;

  // ---- declarations ------------------------------------------------------
  for (const macro of root.descendantsOfType("macro_invocation")) {
    const name = normalize(macro.childForFieldName("macro")?.text ?? "").replace(/^diesel::/u, "");
    const tokens = macro.namedChildren.find((child) => child.type === "token_tree");
    if (!tokens) continue;
    if (name === "table") dieselTables(tokens.text, macro.startPosition.row + 1, data);
    else if (name === "joinable") {
      const match = /^\(\s*(\w+)\s*->\s*(\w+)\s*\(\s*(\w+)\s*\)\s*\)$/u.exec(tokens.text.trim());
      if (match) data.joins.push({ child: match[1]!, parent: match[2]!, key: match[3]! });
    }
  }

  for (const item of root.descendantsOfType("struct_item")) {
    const name = item.childForFieldName("name")?.text;
    if (!name) continue;
    const attributes = rustAttributesOf(item);
    const derives = attributes.filter((attribute) => attribute.name === "derive").flatMap((attribute) => attribute.args.map((arg) => arg.replace(/^.*::/u, "")));
    const line = item.startPosition.row + 1;
    if (derives.includes("FromRow") && hasSqlx) data.models.push({ library: "sqlx", name, line, belongsTo: [] });
    if (derives.some((derive) => DERIVES.has(derive)) && /\bdiesel\b/u.test(source)) {
      let tableIdent: string | undefined;
      const belongsTo: string[] = [];
      for (const attribute of attributes) {
        if (attribute.name === "table_name") {
          const value = attribute.args[0] ? stringLiteralText(attribute.args[0].trim(), new Map()) : null;
          if (value) tableIdent = value;
        }
        if (attribute.name === "belongs_to") belongsTo.push(...attribute.args.map(parentName).filter((value): value is string => value !== null));
        if (attribute.name !== "diesel") continue;
        for (const argument of attribute.args) {
          const table = /^table_name\s*=\s*([\w:"]+)$/u.exec(argument.trim());
          if (table) tableIdent = table[1]!.replace(/"/gu, "").split("::").pop();
          const belongs = /^belongs_to\s*\((.*)\)$/su.exec(argument.trim());
          if (belongs) {
            const parent = parentName(belongs[1]!);
            if (parent) belongsTo.push(parent);
          }
        }
      }
      if (tableIdent) data.models.push({ library: "diesel", name, line, tableIdent, belongsTo });
    }
    if (derives.includes("DeriveEntityModel") && /\bsea_orm\b/u.test(source)) {
      let table: string | null = null;
      for (const attribute of attributes) {
        if (attribute.name !== "sea_orm") continue;
        for (const argument of attribute.args) {
          const match = /^table_name\s*=\s*(.+)$/su.exec(argument.trim());
          if (match) table = stringLiteralText(match[1]!.trim(), new Map());
        }
      }
      const columns: Column[] = [];
      const body = item.childForFieldName("body");
      for (const field of body?.namedChildren ?? []) {
        if (field.type !== "field_declaration") continue;
        const fieldName = field.childForFieldName("name")?.text;
        if (!fieldName) continue;
        const type = field.childForFieldName("type")?.text ?? "";
        const settings = rustAttributesOf(field).filter((attribute) => attribute.name === "sea_orm").flatMap((attribute) => attribute.args.map((arg) => arg.trim()));
        const column = settings.map((setting) => /^column_name\s*=\s*"([^"]*)"$/u.exec(setting)?.[1]).find((value) => value !== undefined) ?? fieldName;
        columns.push({
          name: fieldName.replace(/^r#/u, ""),
          column,
          type: type.replace(/^Option<(.*)>$/su, "$1") || null,
          optional: /^Option</u.test(type),
          list: /^Vec</u.test(type),
          isId: settings.includes("primary_key"),
          isUnique: settings.includes("unique"),
        });
      }
      data.entities.push({ module, table, line, columns, relations: [] });
    }
  }
  for (const enumItem of root.descendantsOfType("enum_item")) {
    if (enumItem.childForFieldName("name")?.text !== "Relation" || data.entities.length === 0) continue;
    const entity = data.entities[0]!;
    for (const variant of enumItem.childForFieldName("body")?.namedChildren ?? []) {
      if (variant.type !== "enum_variant") continue;
      const field = variant.childForFieldName("name")?.text;
      if (!field) continue;
      for (const attribute of rustAttributesOf(variant)) {
        if (attribute.name !== "sea_orm") continue;
        for (const argument of attribute.args) {
          const match = /^(has_many|has_one|belongs_to)\s*=\s*"([^"]*)"$/u.exec(argument.trim());
          if (!match) continue;
          const segments = match[2]!.split("::");
          const target = segments[segments.length - 1] === "Entity" ? segments[segments.length - 2] ?? null : null;
          entity.relations.push({ field, module: target === "self" || target === undefined ? null : target, kind: match[1] === "has_many" ? "many" : "one" });
        }
      }
    }
  }
  for (const use of root.descendantsOfType("use_declaration")) {
    for (const match of use.text.matchAll(/(?:(\w+)::)?Entity\s+as\s+(\w+)/gu)) {
      const owner = match[1] ?? /(\w+)::\{/u.exec(use.text)?.[1];
      if (owner) data.aliases.push({ alias: match[2]!, module: owner });
    }
  }

  // ---- accesses ----------------------------------------------------------
  const add = (candidate: DistributiveOmit<Candidate, "owner">, line: number) => {
    const owner = ownerOf(line);
    if (owner) data.candidates.push({ ...candidate, owner } as Candidate);
  };

  // SeaORM ActiveModel locals: `let mut m: user::ActiveModel = …`.
  const activeLocals = new Map<string, string | null>();
  for (const declaration of root.descendantsOfType("let_declaration")) {
    const type = declaration.childForFieldName("type")?.text.replace(/\s+/gu, "") ?? "";
    const match = /(?:(\w+)::)?ActiveModel$/u.exec(type);
    const pattern = declaration.childForFieldName("pattern");
    const name = pattern?.type === "identifier" ? pattern.text : pattern?.namedChildren.find((child) => child.type === "identifier")?.text;
    if (match && name) activeLocals.set(name, match[1] ?? null);
  }

  if (hasSqlx) {
    for (const macro of root.descendantsOfType("macro_invocation")) {
      const name = normalize(macro.childForFieldName("macro")?.text ?? "");
      const match = /^(?:sqlx::)?query(_as|_scalar)?(?:_unchecked)?$/u.exec(name);
      if (!match) continue;
      if (!name.startsWith("sqlx::") && !bareSqlx) continue;
      const tokens = macro.namedChildren.find((child) => child.type === "token_tree");
      const literal = tokens?.namedChildren.find((child) => child.type === "string_literal" || child.type === "raw_string_literal");
      const sql = literal ? stringLiteral(literal, constants) : null;
      if (sql === null || !tokens) continue;
      const first = tokens.namedChildren[0];
      const asType = match[1] === "_as" && first && first !== literal ? bareType(tokens.text.slice(1, first.endIndex - tokens.startIndex).replace(/^\(/u, "")) : null;
      const line = sqlLine(macro);
      add({ kind: "sql", line, expression: shorten(`${name}!`), sql, asType }, line);
    }
    for (const call of root.descendantsOfType("call_expression")) {
      const callee = normalize(call.childForFieldName("function")?.text ?? "");
      const generics = /::<(.*)>$/u.exec(callee)?.[1];
      const base = callee.replace(/::<.*>$/u, "");
      const isQuery = /^(?:sqlx::)?query(?:_as|_scalar)?(?:_unchecked)?$/u.test(base) && (base.startsWith("sqlx::") || bareSqlx);
      const isBuilder = /^(?:sqlx::)?QueryBuilder::new$/u.test(base);
      if (!isQuery && !isBuilder) continue;
      const first = call.childForFieldName("arguments")?.namedChildren[0];
      const sql = first ? stringLiteral(first, constants) : null;
      if (sql === null) continue;
      const asType = /query_as/u.test(base) && generics ? bareType(generics.split(",").pop() ?? "") : null;
      const line = sqlLine(call);
      add({ kind: "sql", line, expression: shorten(chainText(call)), sql, asType }, line);
    }
  }

  // diesel and SeaORM paths.
  for (const scoped of root.descendantsOfType("scoped_identifier")) {
    if (scoped.parent?.type === "scoped_identifier" || insideUse(scoped)) continue;
    const text = normalize(scoped.text);
    const line = sqlLine(scoped);
    const diesel = /(?:^|::)(\w+)::table$/u.exec(text) ?? /(?:^|::)(\w+)::dsl::(\w+)$/u.exec(text);
    if (diesel && /\bdiesel\b/u.test(source)) {
      const ident = diesel[1]!;
      if (!(diesel[2] && diesel[2] !== ident)) {
        add({ kind: "diesel", line, expression: shorten(chainText(scoped)), ident, operation: dieselOperation(scoped) }, line);
        continue;
      }
    }
    if (/\bsea_orm\b/u.test(source)) {
      const segments = text.split("::");
      const method = segments[segments.length - 1]!;
      const operation = SEA_METHODS.get(method);
      if (!operation || segments.length < 2 || scoped.parent?.type !== "call_expression") continue;
      const owner = segments[segments.length - 2]!;
      const qualifier = owner === "Entity" ? (segments.length >= 3 ? segments[segments.length - 3]! : null) : /^[A-Z]/u.test(owner) ? owner : null;
      if (owner !== "Entity" && qualifier === null) continue;
      const upsert = operation === "create" && /\.on_conflict\(/u.test(chainText(scoped.parent));
      add({ kind: "sea", line, expression: shorten(chainText(scoped)), qualifier: qualifier === "self" || qualifier === "super" ? null : qualifier, operation: upsert ? "upsert" : operation }, line);
    }
  }
  // diesel `users.filter(…)` where `users::dsl::*` is imported.
  for (const ident of new Set(dslImports)) {
    if (new RegExp(String.raw`\b(?:let\s+(?:mut\s+)?|\|)${ident}\b|\b${ident}\s*:\s*[&\w]`, "u").test(source.replace(/\buse\b[^;]*;/gu, ""))) continue;
    for (const node of root.descendantsOfType("identifier")) {
      if (node.text !== ident || insideUse(node)) continue;
      const parent = node.parent;
      if (!parent || parent.type === "scoped_identifier" || parent.type === "let_declaration" || parent.type === "parameter" || parent.type === "field_initializer") continue;
      const inChain = (parent.type === "field_expression" && parent.childForFieldName("value")?.id === node.id)
        || parent.type === "arguments" || parent.type === "reference_expression";
      if (!inChain) continue;
      const line = sqlLine(node);
      add({ kind: "diesel", line, expression: shorten(chainText(node)), ident, operation: dieselOperation(node) }, line);
    }
  }
  // SeaORM ActiveModel writes: `user::ActiveModel { … }.insert(db)`.
  for (const call of root.descendantsOfType("call_expression")) {
    const callee = call.childForFieldName("function");
    if (callee?.type !== "field_expression") continue;
    const method = callee.childForFieldName("field")?.text ?? "";
    const operation = ACTIVE_MODEL_METHODS.get(method);
    if (!operation || !/\bsea_orm\b/u.test(source)) continue;
    let receiver = callee.childForFieldName("value");
    while (receiver?.type === "parenthesized_expression" && receiver.namedChildren[0]) receiver = receiver.namedChildren[0];
    let qualifier: string | null | undefined;
    if (receiver?.type === "struct_expression") {
      const match = /(?:(\w+)::)?ActiveModel$/u.exec(normalize(receiver.childForFieldName("name")?.text ?? ""));
      if (match) qualifier = match[1] ?? null;
    } else if (receiver?.type === "call_expression") {
      const match = /(?:(\w+)::)?ActiveModel::(?:from|new|default)$/u.exec(normalize(receiver.childForFieldName("function")?.text ?? ""));
      if (match) qualifier = match[1] ?? null;
    } else if (receiver?.type === "identifier" && activeLocals.has(receiver.text)) {
      qualifier = activeLocals.get(receiver.text)!;
    }
    if (qualifier === undefined) continue;
    const line = sqlLine(call);
    add({ kind: "sea", line, expression: shorten(chainText(call)), qualifier: qualifier === "self" || qualifier === "super" ? null : qualifier, operation }, line);
  }

  const hasData = data.tables.length + data.joins.length + data.models.length + data.entities.length + data.aliases.length + data.candidates.length > 0;
  const fileNode = nodes.find((node) => node.id === fileNodeId);
  if (fileNode && hasData) fileNode.properties.rustData = JSON.stringify(data);
};

// ---- contributor ----------------------------------------------------------

type Access = { owner: string; modelId: string; operation: Operation; library: string; line: number; expression: string };

export const rustDataAccessContributor: ISemanticContributor = {
  contribute(graph) {
    const files = graph.nodes.filter((node) => node.label === "File" && typeof node.properties.rustData === "string");
    if (files.length === 0) return;
    const parsed = files.map((file) => {
      const data = JSON.parse(String(file.properties.rustData)) as FileData;
      delete file.properties.rustData;
      return { data, fileId: file.id, relativePath: String(file.properties.relativePath) };
    });

    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const tableIds = new Map<string, string>();
    const table = (name: string, library: string, extra?: { declaredIn: string; line: number; columns: Column[] }) => {
      const id = `table:rust:-:${name}`;
      if (!tableIds.has(id)) {
        tableIds.set(id, name);
        nodes.push({ id, label: "Table", properties: { name, kind: "table", library, schemaName: null, provider: null, declaredIn: extra?.declaredIn ?? null, line: extra?.line ?? null, columns: JSON.stringify(extra?.columns ?? []) } });
      } else if (extra) {
        const node = nodes.find((candidate) => candidate.id === id)!;
        if (node.properties.declaredIn === null) Object.assign(node.properties, { declaredIn: extra.declaredIn, line: extra.line, columns: JSON.stringify(extra.columns) });
      }
      return id;
    };
    const tableModels = new Map<string, string>();
    const tableModel = (name: string, library: string) => {
      const id = `datamodel:${library}:${name}`;
      if (!tableModels.has(id)) {
        tableModels.set(id, name);
        nodes.push({ id, label: "DataModel", properties: { name, library } });
        relationships.push({ from: id, to: table(name, library), type: "MAPS_TO_TABLE", properties: {} });
      }
      return id;
    };
    const structModel = (library: string, relativePath: string, name: string, line: number, tableId: string | null) => {
      const id = `datamodel:${library}:${path.posix.dirname(relativePath.split(path.sep).join("/"))}:${name}`;
      if (!nodes.some((node) => node.id === id)) {
        nodes.push({ id, label: "DataModel", properties: { name, library, declaredIn: relativePath, line } });
        if (tableId) relationships.push({ from: id, to: tableId, type: "MAPS_TO_TABLE", properties: {} });
      }
      return id;
    };
    const relation = (from: string, to: string, field: string, kind: "one" | "many", fields: string[]) => {
      relationships.push({ from, to, type: "RELATES_TO", properties: { field, kind, fields: JSON.stringify(fields), references: "[]", relationName: null, onDelete: null } });
    };

    // diesel tables, by ident.
    const dieselTables = new Map<string, { id: string; name: string }>();
    for (const { data, relativePath } of parsed) {
      for (const declared of data.tables) {
        const id = table(declared.name, "diesel", { declaredIn: relativePath, line: declared.line, columns: declared.columns });
        dieselTables.set(declared.ident, { id, name: declared.name });
      }
    }
    // The model of a diesel table: its struct models, else the table's own.
    const dieselModelByIdent = new Map<string, string>();
    const dieselModelByName = new Map<string, string>();
    for (const { data, relativePath } of parsed) {
      for (const model of data.models) {
        if (model.library !== "diesel" || !model.tableIdent) continue;
        const declared = dieselTables.get(model.tableIdent);
        const tableId = declared?.id ?? table(model.tableIdent, "diesel");
        const id = structModel("diesel", relativePath, model.name, model.line, tableId);
        dieselModelByName.set(model.name, id);
        if (!dieselModelByIdent.has(model.tableIdent)) dieselModelByIdent.set(model.tableIdent, id);
      }
    }
    for (const { data } of parsed) {
      for (const model of data.models) {
        const from = dieselModelByName.get(model.name);
        if (model.library !== "diesel" || !from) continue;
        for (const parent of model.belongsTo) {
          const to = dieselModelByName.get(parent);
          if (to) relation(from, to, parent, "one", []);
        }
      }
      for (const join of data.joins) {
        const from = dieselModelByIdent.get(join.child) ?? (dieselTables.has(join.child) ? tableModel(dieselTables.get(join.child)!.name, "diesel") : null);
        const to = dieselModelByIdent.get(join.parent) ?? (dieselTables.has(join.parent) ? tableModel(dieselTables.get(join.parent)!.name, "diesel") : null);
        if (from && to && !relationships.some((rel) => rel.type === "RELATES_TO" && rel.from === from && rel.to === to)) relation(from, to, join.parent, "one", join.key ? [join.key] : []);
      }
    }
    const dieselModel = (ident: string) => {
      const known = dieselModelByIdent.get(ident);
      if (known) return known;
      const declared = dieselTables.get(ident);
      return declared ? tableModel(declared.name, "diesel") : null;
    };

    // SeaORM entities, by module name.
    const entityModels = new Map<string, string>();
    for (const { data, relativePath } of parsed) {
      for (const entity of data.entities) {
        const tableName = entity.table ?? entity.module;
        const tableId = table(tableName, "sea-orm", { declaredIn: relativePath, line: entity.line, columns: entity.columns });
        const id = structModel("sea-orm", relativePath, pascal(entity.module), entity.line, tableId);
        if (!entityModels.has(entity.module)) entityModels.set(entity.module, id);
      }
    }
    for (const { data } of parsed) {
      for (const entity of data.entities) {
        const from = entityModels.get(entity.module);
        if (!from) continue;
        for (const item of entity.relations) {
          const to = item.module === null ? from : entityModels.get(item.module);
          if (to) relation(from, to, item.field, item.kind, []);
        }
      }
    }
    const aliases = new Map<string, string>();
    for (const { data } of parsed) for (const alias of data.aliases) if (!aliases.has(alias.alias)) aliases.set(alias.alias, alias.module);

    // FromRow models and the tables sqlx maps them to.
    const fromRowByName = new Map<string, { relativePath: string; model: Model }>();
    for (const { data, relativePath } of parsed) {
      for (const model of data.models) if (model.library === "sqlx") fromRowByName.set(model.name, { relativePath, model });
    }
    const fromRowIds = new Map<string, string>();
    const fromRow = (name: string, tableName: string | null) => {
      const found = fromRowByName.get(name);
      if (!found) return null;
      let id = fromRowIds.get(name);
      if (!id) {
        id = structModel("sqlx", found.relativePath, name, found.model.line, null);
        fromRowIds.set(name, id);
      }
      if (tableName !== null && !relationships.some((rel) => rel.type === "MAPS_TO_TABLE" && rel.from === id)) {
        relationships.push({ from: id, to: table(tableName, "sqlx"), type: "MAPS_TO_TABLE", properties: {} });
      }
      return id;
    };
    // Every FromRow struct is a DataModel, mapped or not.
    for (const name of fromRowByName.keys()) fromRow(name, null);

    const accesses: Access[] = [];
    for (const { data, fileId } of parsed) {
      void fileId;
      for (const candidate of data.candidates) {
        const base = { owner: candidate.owner, line: candidate.line, expression: candidate.expression };
        if (candidate.kind === "sql") {
          const found = sqlTableAccesses(candidate.sql);
          const single = new Set(found.map((access) => access.table)).size === 1 ? found[0]!.table : null;
          const mapped = candidate.asType && single ? fromRow(candidate.asType, single) : null;
          for (const access of found) {
            accesses.push({ ...base, modelId: mapped && access.table === single ? mapped : tableModel(access.table, "sqlx"), operation: access.operation, library: "sqlx" });
          }
        } else if (candidate.kind === "diesel") {
          const modelId = dieselModel(candidate.ident);
          if (modelId) accesses.push({ ...base, modelId, operation: candidate.operation, library: "diesel" });
        } else {
          const module = candidate.qualifier === null ? parsedModule(parsed, candidate.owner) : entityModels.has(candidate.qualifier) ? candidate.qualifier : aliases.get(candidate.qualifier);
          const modelId = module ? entityModels.get(module) : undefined;
          if (modelId) accesses.push({ ...base, modelId, operation: candidate.operation, library: "sea-orm" });
        }
      }
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
      for (const source of [...routesByFunction.get(access.owner) ?? [], ...entrypointsByFunction.get(access.owner) ?? []]) record(source, access, false);
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

// The entity module of the file a function id belongs to (a bare `Entity::find()`).
function parsedModule(parsed: Array<{ data: FileData; fileId: string }>, owner: string): string | undefined {
  const file = parsed.find((candidate) => owner.startsWith(`${candidate.fileId}:`));
  return file?.data.entities[0]?.module;
}

// ---- parse helpers --------------------------------------------------------

// diesel `table! { users (id) { id -> Int4, name -> Nullable<Text>, } }`: one
// or more tables, `#[sql_name = "…"]` renaming.
function dieselTables(text: string, line: number, data: FileData): void {
  const body = text.trim().replace(/^\{|\}$/gu, "").replace(/\buse\b[^;]*;/gu, " ");
  for (const match of body.matchAll(/((?:#\[[^\]]*\]\s*)*)(?:pub\s+)?(\w+)\s*(?:\(([^)]*)\))?\s*\{([^{}]*)\}/gu)) {
    const sqlName = /#\[\s*sql_name\s*=\s*"([^"]*)"\s*\]/u.exec(match[1] ?? "")?.[1];
    const keys = new Set((match[3] ?? "").split(",").map((key) => key.trim()).filter(Boolean));
    const columns: Column[] = [];
    for (const column of splitColumns(match[4] ?? "")) {
      const parsed = /^\s*((?:#\[[^\]]*\]\s*)*)(\w+)\s*->\s*(.+?)\s*$/su.exec(column);
      if (!parsed) continue;
      const columnName = /#\[\s*sql_name\s*=\s*"([^"]*)"\s*\]/u.exec(parsed[1] ?? "")?.[1] ?? parsed[2]!;
      const type = parsed[3]!;
      columns.push({ name: parsed[2]!, column: columnName, type: type.replace(/^Nullable<(.*)>$/su, "$1"), optional: /^Nullable</u.test(type), list: /^Array</u.test(type), isId: keys.has(parsed[2]!), isUnique: false });
    }
    data.tables.push({ ident: match[2]!, name: sqlName ?? match[2]!, line, columns });
  }
}

// Columns split at the commas outside `Nullable<…>`-style generics (the `>`
// of `->` is not a bracket).
function splitColumns(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === "<") depth += 1;
    else if (char === ">" && text[index - 1] !== "-") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// `User` / `crate::models::User` of `belongs_to(User, foreign_key = "x")`.
function parentName(text: string): string | null {
  const first = text.split(",")[0]?.trim() ?? "";
  return /^[\w:]+$/u.test(first) ? first.split("::").pop()! : null;
}

// The module an entity file stands for: its inline `mod`, else the file stem
// (`entity/user.rs` → `user`, `user/mod.rs` → `user`).
function moduleName(root: SyntaxNode, relativePath: string): string {
  const inline = root.descendantsOfType("mod_item").find((item) => item.childForFieldName("body") && /\bDeriveEntityModel\b/u.test(item.text));
  const name = inline?.childForFieldName("name")?.text;
  if (name) return name;
  const parsed = path.parse(relativePath);
  return ["mod", "lib", "main"].includes(parsed.name) ? path.basename(parsed.dir) : parsed.name;
}

// The diesel operation of the nearest `insert_into(…)` / `update(…)` /
// `delete(…)` the node is an argument of; `.on_conflict(…)` makes an insert
// an upsert.
function dieselOperation(node: SyntaxNode): Operation {
  for (let current: SyntaxNode | null = node; current && current.type !== "function_item"; current = current.parent) {
    const call = current.parent?.type === "arguments" ? current.parent.parent : null;
    if (call?.type !== "call_expression") continue;
    const callee = normalize(call.childForFieldName("function")?.text ?? "").replace(/::<.*>$/u, "");
    const operation = DIESEL_ROOTS.get(callee.split("::").pop() ?? "");
    if (!operation) continue;
    return operation === "create" && /\.on_conflict(?:_do_nothing)?\(/u.test(chainText(call)) ? "upsert" : operation;
  }
  return "read";
}

// The whole method chain a node is the start or an argument of.
function chainText(node: SyntaxNode): string {
  let top = node;
  for (let parent = node.parent; parent; parent = parent.parent) {
    const chained = (parent.type === "field_expression" && parent.childForFieldName("value")?.id === top.id)
      || (parent.type === "call_expression" && parent.childForFieldName("function")?.id === top.id)
      || (parent.type === "try_expression")
      || (parent.type === "await_expression");
    if (!chained) break;
    top = parent;
  }
  return top.text.replace(/\s+/gu, " ").trim();
}

function shorten(text: string): string {
  return text.length > 120 ? `${text.slice(0, 117)}...` : text;
}

function insideUse(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "use_declaration" || parent.type === "attribute_item") return true;
    if (parent.type === "function_item" || parent.type === "source_file") return false;
  }
  return false;
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, "");
}

function bareType(type: string): string {
  return type.trim().replace(/<.*$/su, "").split("::").pop()!.trim();
}

// `user_role` → `UserRole`.
function pascal(name: string): string {
  return name.split(/[_\s]+/u).filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

function stringLiteralText(text: string, constants: Map<string, string>): string | null {
  const plain = /^"((?:[^"\\]|\\.)*)"$/su.exec(text);
  if (plain) return plain[1]!.includes("\\") ? plain[1]!.replace(/\\\n\s*/gu, " ").replace(/\\n/gu, "\n").replace(/\\"/gu, "\"") : plain[1]!;
  const raw = /^r(#*)"(.*)"\1$/su.exec(text);
  if (raw) return raw[2]!;
  return constants.get(text.replace(/^(?:\w+::)*/u, "")) ?? null;
}

function stringLiteral(node: SyntaxNode, constants: Map<string, string>): string | null {
  if (node.type === "reference_expression") {
    const value = node.childForFieldName("value");
    return value ? stringLiteral(value, constants) : null;
  }
  if (node.type === "string_literal" || node.type === "raw_string_literal") return stringLiteralText(node.text, constants);
  if (node.type === "identifier" || node.type === "scoped_identifier") return constants.get(node.text.replace(/^(?:\w+::)*/u, "")) ?? null;
  return null;
}

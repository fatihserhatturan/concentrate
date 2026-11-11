import path from "node:path";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { fileOfNodeId } from "../js-ts/resolution/data-access.js";
import { sqlTableAccesses } from "../go/sql.js";
import type { PythonContext } from "./context.js";
import type { Operation, PyColumn, PyMigration, PyModel, PyRelation } from "./data-facts.js";
import { lastSegment } from "./syntax.js";

export type { PyDataFacts } from "./data-facts.js";

// Python data access: SQLAlchemy (1.x and 2.x, Flask-SQLAlchemy), SQLModel,
// the Django ORM, and the literal SQL of DB-API cursors and drivers.
//
// The parse records, per file, the model classes, `Table(...)` definitions,
// migration operations and every call that reaches data (data-facts.ts). Once
// every file is parsed this makes:
//   - a Table per model (SQLAlchemy `__tablename__`, the snake-cased class name
//     of a Flask-SQLAlchemy `db.Model`, SQLModel `table=True`, Django
//     `Meta.db_table` or `<app>_<model>`) with its columns, inherited from
//     abstract bases and mixins, and a DataModel mapped to it;
//   - RELATES_TO between DataModels: `relationship(...)` (one or many from the
//     foreign key, `uselist`, `secondary` or the `Mapped[list[X]]` type;
//     `backref` and `back_populates` give the other side), Django
//     `ForeignKey` / `OneToOneField` / `ManyToManyField` and the reverse
//     relation each makes (`related_name`, else `<model>_set`);
//   - the migrations of Alembic (`op.create_table`, `add_column`, …) and
//     Django (`CreateModel`, `AddField`, …) merged into those tables, or
//     tables of their own when no model declares them;
//   - ACCESSES_DATA from the function that queries (`session.query(M)`,
//     `select(M)` / `insert` / `update` / `delete`, `session.add`, `M.query`,
//     `session.get`, Django `M.objects.…` and custom managers, `instance.save()`)
//     to the model, and from a literal SQL statement (`cursor.execute("…")`,
//     asyncpg `fetch`, `text("…")`, `read_sql`) to a DataModel of its table.
//     The access is also from the function's routes and entrypoints and the
//     functions that call it; READS / WRITES to the tables follow from the
//     JS/TS data-access contributor, which runs after this one.

type Declared = { id: string; fileId: string; relativePath: string; model: PyModel };

const tableId = (name: string) => `table:python:-:${name}`;

const snake = (name: string) => name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2").toLowerCase();

export function addPythonDataAccess(context: PythonContext): void {
  const { graph, index } = context;
  const files = [...context.dataByFile.entries()];
  if (files.length === 0) return;

  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  const tables = new Map<string, GraphNode>();
  const table = (name: string, library: string, extra?: { declaredIn: string; line: number; columns: PyColumn[] }): GraphNode => {
    const id = tableId(name);
    let node = tables.get(id);
    if (!node) {
      node = { id, label: "Table", properties: { name, kind: "table", library, schemaName: null, provider: null, declaredIn: extra?.declaredIn ?? null, line: extra?.line ?? null, columns: JSON.stringify(extra?.columns ?? []) } };
      tables.set(id, node);
      nodes.push(node);
    } else if (extra && node.properties.declaredIn === null) {
      Object.assign(node.properties, { library, declaredIn: extra.declaredIn, line: extra.line, columns: JSON.stringify(extra.columns) });
    }
    return node;
  };
  const dataModels = new Set<string>();
  const dataModel = (id: string, name: string, library: string, tableNode: GraphNode, extra?: { declaredIn: string; line: number }) => {
    if (dataModels.has(id)) return id;
    dataModels.add(id);
    nodes.push({ id, label: "DataModel", properties: { name, library, ...(extra ?? {}) } });
    relationships.push({ from: id, to: tableNode.id, type: "MAPS_TO_TABLE", properties: {} });
    return id;
  };
  const relation = (from: string, to: string, field: string, kind: "one" | "many", fields: string[], onDelete: string | null = null) => {
    if (relationships.some((rel) => rel.type === "RELATES_TO" && rel.from === from && rel.to === to && rel.properties.field === field)) return;
    relationships.push({ from, to, type: "RELATES_TO", properties: { field, kind, fields: JSON.stringify(fields), references: "[]", relationName: null, onDelete } });
  };

  // ---- models ----
  const declared = new Map<string, Declared>();
  for (const [fileId, data] of files) {
    const relativePath = context.relativeOf.get(fileId) ?? fileId;
    for (const model of data.models) {
      const id = `${fileId}:class:${model.line}:${model.name}`;
      if (context.nodeById.has(id)) declared.set(id, { id, fileId, relativePath, model });
    }
  }
  const byName = new Map<string, Declared[]>();
  for (const entry of declared.values()) byName.set(entry.model.name, [...byName.get(entry.model.name) ?? [], entry]);

  // The model a class name written in `fileId` stands for.
  const resolveModel = (name: string | null, fileId: string, appHint: string | null = null): Declared | null => {
    if (!name) return null;
    const cleaned = name.replace(/^["']|["']$/gu, "");
    const dot = cleaned.lastIndexOf(".");
    const bare = dot < 0 ? cleaned : cleaned.slice(dot + 1);
    if (dot >= 0 && /^[a-z_]\w*$/u.test(cleaned.slice(0, dot)) && !cleaned.slice(0, dot).includes(".")) {
      // Django "app.Model".
      const app = cleaned.slice(0, dot);
      const found = (byName.get(bare) ?? []).find((entry) => appLabelOf(entry) === app);
      if (found) return found;
    }
    for (const lookup of [cleaned, bare]) {
      const id = index.lookupType(lookup, fileId);
      if (id && declared.has(id)) return declared.get(id)!;
    }
    const candidates = byName.get(bare) ?? [];
    if (appHint !== null) {
      const local = candidates.filter((entry) => appLabelOf(entry) === appHint);
      if (local.length === 1) return local[0]!;
    }
    return candidates.length === 1 ? candidates[0]! : null;
  };
  const appLabelOf = (entry: Declared): string | null => {
    if (entry.model.appLabel) return entry.model.appLabel;
    const parts = entry.relativePath.split(path.sep).join("/").split("/");
    const file = parts.at(-1) ?? "";
    if (file === "models.py") return parts.at(-2) ?? null;
    const at = parts.lastIndexOf("models");
    return at > 0 ? parts[at - 1]! : parts.at(-2) ?? null;
  };

  type Resolved = { entry: Declared; table: string; columns: PyColumn[]; relations: Array<PyRelation & { owner: Declared }> };
  const resolved = new Map<string, Resolved>();
  for (const entry of declared.values()) {
    const { model } = entry;
    if (model.abstract || model.proxy) continue;
    const chain = context.classChain(entry.id).ids.map((id) => declared.get(id)).filter((candidate): candidate is Declared => candidate !== undefined);
    // Bases the chain cannot resolve (`db.Model`, `models.Model`).
    const unresolvedBases = new Set<string>();
    for (const member of chain) for (const base of member.model.bases) unresolvedBases.add(lastSegment(base));
    let tablename: string | null = null;
    let isTable = false;
    if (model.library === "django") {
      isTable = true;
      tablename = model.tablename ?? `${appLabelOf(entry) ?? "app"}_${model.name.toLowerCase()}`;
    } else if (model.library === "sqlmodel") {
      isTable = chain.some((member) => member.id === entry.id && member.model.tableTrue);
      tablename = model.tablename ?? model.name.toLowerCase();
    } else {
      isTable = model.tablename !== null || ((model.columns.length > 0 || chain.some((member) => member.model.columns.length > 0)) && [...unresolvedBases].some((base) => base === "Model"));
      tablename = model.tablename ?? (isTable ? snake(model.name) : null);
      // A model that inherits `__tablename__` from a mixin has a table of its own only through the declarative base.
    }
    if (!isTable || !tablename) continue;
    const columns = new Map<string, PyColumn>();
    const relationsOfModel: Resolved["relations"] = [];
    // The class's own members win over its bases'.
    for (const member of chain) {
      for (const column of member.model.columns) if (!columns.has(column.name)) columns.set(column.name, column);
      for (const item of member.model.relations) if (!relationsOfModel.some((existing) => existing.field === item.field)) relationsOfModel.push({ ...item, owner: member });
    }
    if (model.library === "django" && !chain.some((member) => member.model.hasPrimaryKey)) columns.set("id", { name: "id", column: "id", type: "Auto", optional: false, list: false, isId: true, isUnique: true });
    resolved.set(entry.id, { entry, table: tablename, columns: [...columns.values()], relations: relationsOfModel });
  }

  const modelIdOf = (entry: Declared) => `datamodel:${entry.model.library}:${path.posix.dirname(entry.relativePath.split(path.sep).join("/"))}:${entry.model.name}`;
  const tableOf = new Map<string, GraphNode>();
  for (const item of resolved.values()) {
    const node = table(item.table, item.entry.model.library, { declaredIn: item.entry.relativePath, line: item.entry.model.line, columns: item.columns });
    tableOf.set(item.entry.id, node);
    dataModel(modelIdOf(item.entry), item.entry.model.name, item.entry.model.library, node, { declaredIn: item.entry.relativePath, line: item.entry.model.line });
  }
  // Models of the same table (SQLAlchemy single-table inheritance, Django proxies) share it; a model nobody resolved is left out.
  const modelsByTable = new Map<string, Resolved[]>();
  for (const item of resolved.values()) modelsByTable.set(item.table.toLowerCase(), [...modelsByTable.get(item.table.toLowerCase()) ?? [], item]);

  // Relations, with the reverse side each one makes.
  const resolvedByEntry = (entry: Declared | null) => (entry ? resolved.get(entry.id) ?? null : null);
  for (const item of resolved.values()) {
    for (const rel of item.relations) {
      const target = resolveModel(rel.target === "self" ? item.entry.model.name : rel.target, rel.owner.fileId, appLabelOf(item.entry));
      const targetItem = resolvedByEntry(target);
      if (!targetItem) continue;
      let kind: "one" | "many" = rel.kind ?? "one";
      if (rel.kind === null) {
        // From the keys: a foreign key of this table to the target's table is "one"; the other way around, "many".
        const toTarget = item.columns.some((column) => column.references !== undefined && column.references.split(".")[0]?.toLowerCase() === targetItem.table.toLowerCase());
        // Without keys (a helper makes the column), a plural field name is a collection.
        kind = toTarget ? "one" : /s$/u.test(rel.field) ? "many" : "one";
      }
      const from = modelIdOf(item.entry);
      const to = modelIdOf(targetItem.entry);
      const fk = rel.via === "relationship" ? item.columns.filter((column) => column.references?.split(".")[0]?.toLowerCase() === targetItem.table.toLowerCase()).map((column) => column.name) : [rel.field];
      relation(from, to, rel.field, kind, fk);
      // The other side: Django's `related_name` (default `<model>_set`, or the model for a one-to-one) and
      // SQLAlchemy's `backref` (a `back_populates` is declared by the other class itself).
      const django = item.entry.model.library === "django";
      const reverseName = django ? (rel.backref === null ? (rel.via === "o2o" ? item.entry.model.name.toLowerCase() : `${item.entry.model.name.toLowerCase()}_set`) : rel.backref || null) : rel.backref || null;
      if (reverseName) {
        const reverseKind: "one" | "many" = django ? (rel.via === "o2o" ? "one" : "many") : rel.backKind ?? (kind === "one" ? "many" : rel.via === "m2m" ? "many" : "one");
        relation(to, from, reverseName, reverseKind, []);
      }
    }
  }

  // ---- core Table(...) definitions and migrations ----
  const migrationEntries = new Map<string, Array<{ file: string; line: number; order: number; change: string }>>();
  const migrationColumns = new Map<string, PyColumn[]>();
  const declaredElsewhere = new Set<string>();
  for (const [fileId, data] of files) {
    const relativePath = context.relativeOf.get(fileId) ?? fileId;
    for (const core of data.tables) {
      const node = table(core.name, "sqlalchemy", { declaredIn: relativePath, line: core.line, columns: core.columns });
      declaredElsewhere.add(node.id);
    }
  }
  const migrationFiles = files
    .filter(([, data]) => data.migrations.length > 0)
    .map(([fileId, data]) => ({ fileId, data, relativePath: (context.relativeOf.get(fileId) ?? fileId).split(path.sep).join("/") }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  let order = 0;
  const migrationTable = (migration: PyMigration, appModels: Map<string, string>): string | null => {
    if (migration.kind === "alembic") return migration.table;
    const model = migration.model ?? "";
    return appModels.get(`${migration.table}.${model.toLowerCase()}`) ?? `${migration.table}_${model.toLowerCase()}`;
  };
  const appModels = new Map<string, string>();
  for (const item of resolved.values()) appModels.set(`${appLabelOf(item.entry)}.${item.entry.model.name.toLowerCase()}`, item.table);
  for (const { data, relativePath } of migrationFiles) {
    order += 1;
    for (const migration of data.migrations) {
      let name = migrationTable(migration, appModels);
      if (migration.kind === "django" && migration.op === "create_model" && migration.options.db_table) name = migration.options.db_table;
      if (!name) continue;
      const change = migration.op === "create_table" || migration.op === "create_model" ? "create"
        : migration.op === "add_column" || migration.op === "add_field" ? `add column ${migration.column ?? ""}`.trim()
          : migration.op === "drop_column" || migration.op === "remove_field" ? `drop column ${migration.column ?? ""}`.trim()
            : "drop";
      const key = name.toLowerCase();
      migrationEntries.set(key, [...migrationEntries.get(key) ?? [], { file: relativePath, line: migration.line, order, change }]);
      if (migration.columns.length > 0) migrationColumns.set(key, [...migrationColumns.get(key) ?? [], ...migration.columns]);
      if (!tables.has(tableId(name)) && migration.op !== "drop_table" && migration.op !== "delete_model" && (migration.op === "create_table" || migration.op === "create_model")) {
        table(name, migration.kind === "alembic" ? "alembic" : "django", { declaredIn: relativePath, line: migration.line, columns: migration.columns });
      }
    }
  }
  for (const node of tables.values()) {
    const key = String(node.properties.name).toLowerCase();
    const entries = migrationEntries.get(key);
    if (entries) node.properties.migrations = JSON.stringify(entries);
    const extra = migrationColumns.get(key);
    if (extra) {
      const columns = JSON.parse(String(node.properties.columns)) as PyColumn[];
      const names = new Set(columns.flatMap((column) => [column.name.toLowerCase(), column.column.toLowerCase()]));
      for (const column of extra) if (!names.has(column.name.toLowerCase()) && !names.has(column.column.toLowerCase())) columns.push(column);
      node.properties.columns = JSON.stringify(columns);
    }
  }

  // ---- accesses ----
  type Access = { owner: string; ownerClass: string | null; fileId: string; modelId: string; operation: Operation; library: string; line: number; expression: string };
  const accesses: Access[] = [];
  const sqlModels = new Map<string, string>();
  const modelForTable = (name: string): string => {
    const found = modelsByTable.get(name.toLowerCase())?.[0];
    if (found) return modelIdOf(found.entry);
    const node = table(name, "dbapi");
    const id = `datamodel:dbapi:${name}`;
    if (!sqlModels.has(id)) {
      sqlModels.set(id, name);
      dataModel(id, name, "dbapi", node);
    }
    return id;
  };
  for (const [fileId, data] of files) {
    for (const candidate of data.candidates) {
      const base = { owner: candidate.owner, ownerClass: candidate.ownerClass, fileId, line: candidate.line, expression: candidate.expression };
      if (candidate.kind === "sql") {
        for (const found of sqlTableAccesses(candidate.sql)) accesses.push({ ...base, modelId: modelForTable(found.table), operation: found.operation, library: "dbapi" });
        continue;
      }
      const target = resolveModel(candidate.name, fileId);
      const item = resolvedByEntry(target);
      if (!item) continue;
      // A manager other than `objects` must be one the model (or a base) declares.
      if (candidate.kind === "model" && candidate.manager && candidate.manager !== "objects" && candidate.manager !== "_default_manager" && candidate.manager !== "_base_manager") {
        const chain = context.classChain(item.entry.id).ids.map((id) => declared.get(id)).filter((entry): entry is Declared => entry !== undefined);
        if (!chain.some((member) => member.model.managers.includes(candidate.manager!))) continue;
      }
      if (candidate.kind === "model" && candidate.manager === undefined && item.entry.model.library === "django") continue;
      // `.save()` / `.delete()` of a Flask-SQLAlchemy mixin is a write of any model that has the mixin.
      accesses.push({ ...base, modelId: modelIdOf(item.entry), operation: candidate.operation, library: item.entry.model.library });
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
  // The methods of the class a class-level query (`queryset = M.objects.all()`) is written in.
  const methodsOfClass = (fileId: string, className: string): string[] => {
    const classId = index.classByFileAndName.get(fileId)?.get(className);
    return classId ? [...index.methods.get(classId)?.values() ?? []].flat() : [];
  };
  for (const access of accesses) {
    const owners = access.owner === access.fileId && access.ownerClass ? [access.owner, ...methodsOfClass(access.fileId, access.ownerClass)] : [access.owner];
    for (const owner of owners) {
      if (record(owner, access, owner === access.owner)) accessesByFunction.set(owner, [...accessesByFunction.get(owner) ?? [], access]);
      for (const source of [...routesByFunction.get(owner) ?? [], ...entrypointsByFunction.get(owner) ?? []]) record(source, access, false);
    }
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
}

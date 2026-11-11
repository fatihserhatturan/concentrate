import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { PythonParsePlugin } from "../../languages/python/parser.js";
import { walk } from "../../languages/tree-sitter-utils.js";
import { argsOf, compact, createOwnerOf, lastSegment, shorten, stringConstants, stringOnly, stringValue, unwrap } from "./syntax.js";

// What a Python file says about its data, in the words of its source: the
// model classes (SQLAlchemy, SQLModel and Django ORM), `Table(...)`
// definitions, Alembic and Django migration operations, and each call that
// reaches data (ORM queries and the literal SQL of DB-API cursors). Names stay
// text: data-access.ts resolves them with the names of the whole scan, then
// removes this record from the File node.

export type Operation = "read" | "create" | "update" | "delete" | "upsert";

export type PyColumn = { name: string; column: string; type: string | null; optional: boolean; list: boolean; isId: boolean; isUnique: boolean; references?: string };

export type PyRelation = {
  field: string;
  // The class a relationship names: `"Profile"`, `"profiles.Profile"`, `Profile`, `"self"`.
  target: string | null;
  // Set for sure by the source (`Mapped[list[X]]`, `uselist`, `secondary`, ManyToMany); null leaves it to the keys.
  kind: "one" | "many" | null;
  // `backref="x"` / `related_name="x"`; the name on the other side.
  backref: string | null;
  backPopulates: string | null;
  // `backref=db.backref("x", uselist=False)`.
  backKind: "one" | "many" | null;
  // SQLAlchemy relationship, or Django field kind (`fk`, `o2o`, `m2m`).
  via: "relationship" | "fk" | "o2o" | "m2m";
};

export type PyModel = {
  name: string;
  line: number;
  library: "sqlalchemy" | "django" | "sqlmodel";
  bases: string[];
  tablename: string | null;
  // SQLModel `table=True`.
  tableTrue: boolean;
  abstract: boolean;
  proxy: boolean;
  appLabel: string | null;
  columns: PyColumn[];
  relations: PyRelation[];
  // A field was marked `primary_key=True`.
  hasPrimaryKey: boolean;
  // Names assigned a manager (`published = PublishedManager()`).
  managers: string[];
};

export type PyCoreTable = { name: string; line: number; columns: PyColumn[] };

export type PyMigration = { kind: "alembic" | "django"; op: string; table: string; model: string | null; line: number; columns: PyColumn[]; column: string | null; options: Record<string, string> };

export type PyCandidate =
  | { kind: "model"; owner: string; ownerClass: string | null; line: number; expression: string; name: string; operation: Operation; manager?: string }
  // `session.add(user)` where `user` is typed by the function.
  | { kind: "instance"; owner: string; ownerClass: string | null; line: number; expression: string; name: string; operation: Operation }
  | { kind: "sql"; owner: string; ownerClass: string | null; line: number; expression: string; sql: string };

export type PyDataFacts = {
  models: PyModel[];
  tables: PyCoreTable[];
  migrations: PyMigration[];
  candidates: PyCandidate[];
};

const DJANGO_FIELD = /^(?:\w*Field|ForeignKey|OneToOneField|ManyToManyField|GenericForeignKey|GenericRelation)$/u;
const SQL_METHODS = new Set(["execute", "executemany", "executescript", "fetch", "fetchrow", "fetchval", "fetchmany", "prepare", "copy_records_to_table", "mogrify", "exec_driver_sql"]);
const READ_SQL = new Set(["read_sql", "read_sql_query", "read_sql_table"]);
const SESSION_RECEIVER = /session|^db$|^sess$|^s$|^ses$|^conn$|^connection$/iu;
const DJANGO_QUERY_METHODS = new Map<string, Operation>([
  ["all", "read"], ["filter", "read"], ["exclude", "read"], ["get", "read"], ["first", "read"], ["last", "read"], ["count", "read"], ["exists", "read"],
  ["values", "read"], ["values_list", "read"], ["aggregate", "read"], ["annotate", "read"], ["select_related", "read"], ["prefetch_related", "read"],
  ["order_by", "read"], ["iterator", "read"], ["in_bulk", "read"], ["latest", "read"], ["earliest", "read"], ["distinct", "read"], ["none", "read"],
  ["only", "read"], ["defer", "read"], ["raw", "read"], ["select_for_update", "read"], ["reverse", "read"], ["union", "read"], ["alias", "read"], ["using", "read"],
  ["create", "create"], ["create_user", "create"], ["create_superuser", "create"], ["get_or_create", "create"], ["bulk_create", "create"], ["update_or_create", "upsert"], ["update", "update"], ["bulk_update", "update"], ["delete", "delete"],
]);
const SA_FUNCTIONS = new Map<string, Operation>([["select", "read"], ["insert", "create"], ["update", "update"], ["delete", "delete"]]);
const SIGNAL = /sqlalchemy|sqlmodel|django|\bmodels\b|\.query\b|\bselect\b|\binsert\b|\bexecute|\bfetch|read_sql|__tablename__|alembic|\bop\.|\bobjects\b|\bsession\b|\bTable\(/iu;

const LITERAL_TRUE = (node: SyntaxNode | undefined) => node?.text === "True";

export const pythonDataPlugin: PythonParsePlugin = ({ fileNodeId, relativePath, root, nodes, functions }) => {
  const source = root.text;
  if (!SIGNAL.test(source)) return;
  const fileNode = nodes.find((node) => node.id === fileNodeId);
  if (!fileNode) return;
  const ownerOf = createOwnerOf(fileNodeId, functions);
  const constants = stringConstants(root);
  const posix = relativePath.split("\\").join("/");

  const facts: PyDataFacts = { models: [], tables: [], migrations: [], candidates: [] };
  const hasDjango = /\bdjango\b|\.objects\b|_default_manager/u.test(source);
  const hasSqlModel = /\bsqlmodel\b/iu.test(source);
  const hasSqlAlchemy = /sqlalchemy|\bdb\.Model\b|\bMapped\b|\bflask_sqlalchemy\b/iu.test(source);

  const classAround = (line: number): string | null => {
    let best: { name: string; span: number } | null = null;
    for (const definition of classes) {
      const start = definition.startPosition.row + 1;
      const end = definition.endPosition.row + 1;
      if (start <= line && line <= end) {
        const name = definition.childForFieldName("name")?.text;
        if (name && (best === null || end - start < best.span)) best = { name, span: end - start };
      }
    }
    return best?.name ?? null;
  };
  const classes = root.descendantsOfType("class_definition");
  // Fields imported by name: `from django.db.models import CharField`.
  const djangoNames = new Set<string>();
  for (const match of source.matchAll(/^\s*from\s+django\.db\.models(?:\.fields)?\s+import\s+\(?([^)\n]+)/gmu)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().split(/\s+as\s+/u).at(-1)?.trim();
      if (name) djangoNames.add(name);
    }
  }
  const classOwner = (line: number): { owner: string; ownerClass: string | null } => {
    const owner = ownerOf(line);
    return { owner, ownerClass: owner === fileNodeId ? classAround(line) : null };
  };

  // ---- models ------------------------------------------------------------
  if (hasDjango || hasSqlModel || hasSqlAlchemy) {
    for (const definition of classes) {
      const model = readModel(definition, { hasDjango, hasSqlModel, hasSqlAlchemy }, constants, posix, djangoNames);
      if (model) facts.models.push(model);
    }
    for (const call of root.descendantsOfType("call")) {
      if (lastSegment(compact(call.childForFieldName("function")?.text ?? "")) !== "Table") continue;
      const { positional } = argsOf(call);
      const name = stringOnly(positional[0], constants);
      if (name === null || positional.length < 2) continue;
      const columns = positional.slice(1).flatMap((arg) => (arg.type === "call" && lastSegment(compact(arg.childForFieldName("function")?.text ?? "")) === "Column" ? [columnOf(arg, "", null, constants)] : []));
      if (columns.length > 0) facts.tables.push({ name, line: call.startPosition.row + 1, columns: columns.filter((column): column is PyColumn => column !== null) });
    }
  }

  // ---- migrations --------------------------------------------------------
  if (/\bop\.(?:create_table|add_column|drop_column|drop_table)\b/u.test(source)) readAlembic(root, constants, facts);
  if (/\bmigrations\.(?:CreateModel|AddField|RemoveField|DeleteModel|AlterField)\b/u.test(source)) readDjangoMigration(root, constants, facts, posix);

  // ---- queries -----------------------------------------------------------
  // Variables of a function typed by a constructor, a parameter annotation or `session.get(M, id)`.
  type Typed = { name: string; constructed: boolean };
  const typedByFunction = new Map<string, Map<string, Typed>>();
  for (const fn of functions) {
    const typed = new Map<string, Typed>();
    for (const parameter of fn.syntax.childForFieldName("parameters")?.namedChildren ?? []) {
      const name = parameter.type === "typed_parameter" ? parameter.namedChildren.find((child) => child.type === "identifier")?.text : parameter.childForFieldName("name")?.text;
      const type = parameter.childForFieldName("type")?.text.replace(/^["']|["']$/gu, "").replace(/^Optional\[(.*)\]$/u, "$1").replace(/\s*\|\s*None$/u, "");
      if (name && type && /^[A-Za-z_][\w.]*$/u.test(type)) typed.set(name, { name: type, constructed: false });
    }
    walk(fn.syntax.childForFieldName("body") ?? fn.syntax, (node) => {
      if (node.type !== "assignment") return;
      const left = node.childForFieldName("left");
      const right = unwrap(node.childForFieldName("right"));
      if (left?.type !== "identifier" || right?.type !== "call") return;
      const callee = compact(right.childForFieldName("function")?.text ?? "");
      // `x = Model.query.filter(..).first()`, `Model.objects.get(..)`, `session.query(Model)..one()`: a row of the model.
      const row = rowModel(right);
      if (row) {
        typed.set(left.text, { name: row, constructed: false });
        return;
      }
      const construct = /^([A-Za-z_][\w.]*?)(?:\.(?:model_validate|from_orm|parse_obj|from_dict))?$/u.exec(callee);
      if (construct && /^[A-Z]/u.test(lastSegment(construct[1]!))) typed.set(left.text, { name: construct[1]!, constructed: true });
      else if (/\.get$/u.test(callee) && SESSION_RECEIVER.test(callee.split(".").slice(-2)[0] ?? "")) {
        const model = argsOf(right).positional[0];
        if (model && /^[A-Za-z_][\w.]*$/u.test(model.text)) typed.set(left.text, { name: model.text, constructed: false });
      }
    });
    typedByFunction.set(fn.node.id, typed);
  }

  const chainTop = (node: SyntaxNode): SyntaxNode => {
    let top = node;
    for (let parent = node.parent; parent; parent = parent.parent) {
      const chained = (parent.type === "attribute" && parent.childForFieldName("object")?.id === top.id)
        || (parent.type === "call" && parent.childForFieldName("function")?.id === top.id)
        || parent.type === "await";
      if (!chained) break;
      top = parent;
    }
    return top;
  };
  const writeOf = (text: string, fallback: Operation): Operation => {
    if (/\.on_conflict_do_(?:update|nothing)\(|\.on_duplicate_key_update\(/u.test(text)) return "upsert";
    if (/\.delete\(/u.test(text)) return "delete";
    if (/\.(?:update|bulk_update_mappings)\(/u.test(text)) return "update";
    return fallback;
  };
  const modelRef = (node: SyntaxNode | null | undefined): string | null => {
    let current = unwrap(node);
    // `User.id`, `models.User.name`: the class of a column.
    if (current?.type === "attribute") {
      const text = compact(current.text);
      const segments = text.split(".");
      const lowerFirst = segments.length > 1 && /^[a-z_]/u.test(segments.at(-1)!) ? segments.slice(0, -1).join(".") : text;
      return /^[A-Za-z_][\w.]*$/u.test(lowerFirst) ? lowerFirst : null;
    }
    if (current?.type === "call") current = null;
    return current?.type === "identifier" ? current.text : null;
  };
  const add = (candidate: PyCandidate) => facts.candidates.push(candidate);

  for (const call of root.descendantsOfType("call")) {
    const callee = call.childForFieldName("function");
    if (!callee) continue;
    const line = (callee.type === "attribute" ? callee.childForFieldName("attribute") ?? call : call).startPosition.row + 1;
    const { positional } = argsOf(call);
    const where = classOwner(line);
    const expressionOf = (node: SyntaxNode) => shorten(chainTop(node).text);
    const text = compact(callee.text);
    const method = callee.type === "attribute" ? callee.childForFieldName("attribute")?.text ?? "" : "";
    const object = callee.type === "attribute" ? callee.childForFieldName("object") : null;
    const objectText = compact(object?.text ?? "");

    // SQLAlchemy 1.x `session.query(M)` and `M.query.…`.
    if (method === "query" && object && SESSION_RECEIVER.test(lastSegment(objectText))) {
      for (const arg of positional) {
        const name = modelRef(arg);
        if (name) add({ kind: "model", ...where, line, expression: expressionOf(call), name, operation: writeOf(chainTop(call).text, "read") });
      }
      continue;
    }
    const queryOwner = object?.type === "attribute" && object.childForFieldName("attribute")?.text === "query" ? compact(object.childForFieldName("object")?.text ?? "") : null;
    if (queryOwner !== null && (/^[A-Z]/u.test(lastSegment(queryOwner)) || queryOwner === "self" || queryOwner === "cls")) {
      // `User.query.filter(...)`, `self.query…` of a model's own method: reported once, at the first method after `.query`.
      const name = queryOwner === "self" || queryOwner === "cls" ? classAround(line) : queryOwner;
      if (!name) continue;
      add({ kind: "model", ...where, line, expression: expressionOf(call), name, operation: writeOf(chainTop(call).text, "read") });
      continue;
    }
    // `select(M)`, `insert(M)`, `update(M)`, `delete(M)` of SQLAlchemy and SQLModel.
    const bare = lastSegment(text);
    if (SA_FUNCTIONS.has(bare) && (callee.type === "identifier" || /^(?:sa|sqlalchemy|sql|orm)\./u.test(text))) {
      for (const arg of positional) {
        const name = modelRef(arg);
        if (name) add({ kind: "model", ...where, line, expression: expressionOf(call), name, operation: bare === "select" ? writeOf(chainTop(call).text, "read") : writeOf(chainTop(call).text, SA_FUNCTIONS.get(bare)!) });
      }
      continue;
    }
    // `session.get(M, id)`.
    if (method === "get" && object && SESSION_RECEIVER.test(lastSegment(objectText)) && positional.length >= 2) {
      const name = modelRef(positional[0]);
      if (name && /^[A-Z]/u.test(lastSegment(name))) add({ kind: "model", ...where, line, expression: expressionOf(call), name, operation: "read" });
      continue;
    }
    // `session.add(user)`, `add_all`, `merge`, `delete`.
    if ((method === "add" || method === "add_all" || method === "merge" || method === "delete") && object && SESSION_RECEIVER.test(lastSegment(objectText)) && positional[0]) {
      const argument = unwrap(positional[0])!;
      const typed = typedByFunction.get(where.owner)?.get(argument.text);
      if (method === "delete") {
        if (typed) add({ kind: "instance", ...where, line, expression: expressionOf(call), name: typed.name, operation: "delete" });
      } else if (argument.type === "call") {
        const constructed = compact(argument.childForFieldName("function")?.text ?? "").replace(/\.(?:model_validate|from_orm)$/u, "");
        if (/^[A-Z]/u.test(lastSegment(constructed))) add({ kind: "instance", ...where, line, expression: expressionOf(call), name: constructed, operation: method === "merge" ? "upsert" : "create" });
      } else if (typed) {
        add({ kind: "instance", ...where, line, expression: expressionOf(call), name: typed.name, operation: typed.constructed ? (method === "merge" ? "upsert" : "create") : "update" });
      }
      continue;
    }
    // `instance.save()` / `instance.delete()` of a typed variable or a constructor call (Django, and the `save` / `delete` of
    // a Flask-SQLAlchemy mixin); the contributor keeps those of a class that is a model.
    if ((method === "save" || method === "delete") && object && positional.length === 0) {
      const receiver = unwrap(object);
      if (receiver?.type === "identifier") {
        const typed = typedByFunction.get(where.owner)?.get(receiver.text);
        if (typed) add({ kind: "instance", ...where, line, expression: expressionOf(call), name: typed.name, operation: method === "delete" ? "delete" : typed.constructed ? "create" : "update" });
      } else if (receiver?.type === "call") {
        const constructed = compact(receiver.childForFieldName("function")?.text ?? "");
        if (/^[A-Za-z_][\w.]*$/u.test(constructed) && /^[A-Z]/u.test(lastSegment(constructed))) add({ kind: "instance", ...where, line, expression: expressionOf(call), name: constructed, operation: method === "delete" ? "delete" : "create" });
      }
      continue;
    }
    // Django `M.objects.method(...)`, `M.published.method(...)`.
    if (hasDjango && object?.type === "attribute" && DJANGO_QUERY_METHODS.has(method)) {
      const manager = object.childForFieldName("attribute")?.text ?? "";
      const owner = compact(object.childForFieldName("object")?.text ?? "");
      if (/^[A-Za-z_][\w.]*$/u.test(owner) && /^[A-Z]/u.test(lastSegment(owner)) && (manager === "objects" || manager === "_default_manager" || manager === "_base_manager" || /^[a-z_]\w*$/u.test(manager))) {
        add({ kind: "model", ...where, line, expression: expressionOf(call), name: owner, manager, operation: DJANGO_QUERY_METHODS.get(method) === "read" ? writeOf(chainTop(call).text, "read") : DJANGO_QUERY_METHODS.get(method)! });
      }
      continue;
    }
    // DB-API and driver SQL: `cursor.execute("…")`, `conn.fetch("…")`, `pd.read_sql("…")`.
    if ((method !== "" && SQL_METHODS.has(method)) || READ_SQL.has(bare)) {
      let first = unwrap(positional[0]);
      if (first?.type === "call" && /^(?:text|SQL|sql\.SQL|sa\.text|sqlalchemy\.text)$/u.test(compact(first.childForFieldName("function")?.text ?? ""))) first = unwrap(argsOf(first).positional[0]);
      const sql = stringValue(first, constants, () => "?");
      if (sql !== null && /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*\(?\s*(?:select|insert|update|delete|replace|with|merge)\b/iu.test(sql)) add({ kind: "sql", ...where, line, expression: shorten(call.text), sql });
    }
  }

  // `res = Article.query`: the query object itself, not followed by a method.
  for (const attribute of root.descendantsOfType("attribute")) {
    if (attribute.childForFieldName("attribute")?.text !== "query" || attribute.parent?.type === "attribute") continue;
    const owner = compact(attribute.childForFieldName("object")?.text ?? "");
    if (!/^[A-Za-z_][\w.]*$/u.test(owner) || !/^[A-Z]/u.test(lastSegment(owner))) continue;
    const line = attribute.startPosition.row + 1;
    add({ kind: "model", ...classOwner(line), line, expression: shorten(chainTop(attribute).text), name: owner, operation: "read" });
  }

  if (facts.models.length + facts.tables.length + facts.migrations.length + facts.candidates.length === 0) return;
  fileNode.properties.pyData = JSON.stringify(facts);
};

// ---- models ---------------------------------------------------------------

function readModel(
  definition: SyntaxNode,
  libraries: { hasDjango: boolean; hasSqlModel: boolean; hasSqlAlchemy: boolean },
  constants: ReadonlyMap<string, string>,
  posix: string,
  djangoNames: ReadonlySet<string>,
): PyModel | null {
  const name = definition.childForFieldName("name")?.text;
  const body = definition.childForFieldName("body");
  if (!name || !body) return null;
  const superclasses = definition.childForFieldName("superclasses")?.namedChildren ?? [];
  const bases = superclasses.filter((base) => base.type !== "keyword_argument").map((base) => compact(base.text));
  const tableTrue = superclasses.some((base) => base.type === "keyword_argument" && base.childForFieldName("name")?.text === "table" && LITERAL_TRUE(base.childForFieldName("value") ?? undefined));
  const statements = body.namedChildren;

  let tablename: string | null = null;
  let abstract = false;
  let proxy = false;
  let appLabel: string | null = null;
  const columns: PyColumn[] = [];
  const relations: PyRelation[] = [];
  const managers: string[] = [];
  let hasPrimaryKey = false;
  let djangoFields = 0;
  let sqlFields = 0;
  // SQLAlchemy's own field calls, which tell a SQLAlchemy model from a SQLModel one in a file that has both libraries.
  let sqlalchemyStyle = false;

  for (const statement of statements) {
    if (statement.type === "class_definition" && statement.childForFieldName("name")?.text === "Meta") {
      for (const inner of statement.childForFieldName("body")?.namedChildren ?? []) {
        const assignment = inner.type === "expression_statement" ? inner.namedChildren[0] : null;
        if (assignment?.type !== "assignment") continue;
        const key = assignment.childForFieldName("left")?.text;
        const value = assignment.childForFieldName("right") ?? undefined;
        if (key === "db_table") tablename = stringOnly(value, constants);
        else if (key === "abstract") abstract = LITERAL_TRUE(value);
        else if (key === "proxy") proxy = LITERAL_TRUE(value);
        else if (key === "app_label") appLabel = stringOnly(value, constants);
      }
      continue;
    }
    const assignment = statement.type === "expression_statement" ? statement.namedChildren[0] : null;
    if (assignment?.type !== "assignment") continue;
    const left = assignment.childForFieldName("left");
    const annotation = assignment.childForFieldName("type");
    const right = unwrap(assignment.childForFieldName("right"));
    if (left?.type !== "identifier") continue;
    const field = left.text;
    if (field === "__tablename__") {
      tablename = stringOnly(right ?? undefined, constants);
      continue;
    }
    if (field === "__abstract__") {
      abstract = LITERAL_TRUE(right ?? undefined);
      continue;
    }
    if (field.startsWith("_") || field === "model_config") continue;
    const callee = right?.type === "call" ? lastSegment(compact(right.childForFieldName("function")?.text ?? "")) : "";

    // Django fields and managers.
    const calleeText = right?.type === "call" ? compact(right.childForFieldName("function")?.text ?? "") : "";
    const djangoCallee = DJANGO_FIELD.test(callee) && (/^(?:django\.db\.)?models\.|^(?:postgres|contrib\.\w+)\.fields\.|^fields\./u.test(calleeText) || djangoNames.has(calleeText));
    if (libraries.hasDjango && right?.type === "call" && djangoCallee) {
      djangoFields += 1;
      const args = argsOf(right);
      if (callee === "ManyToManyField" || callee === "ForeignKey" || callee === "OneToOneField") {
        const via = callee === "ForeignKey" ? "fk" : callee === "OneToOneField" ? "o2o" : "m2m";
        const targetNode = args.positional[0] ?? args.keywords.get("to");
        const relatedName = stringOnly(args.keywords.get("related_name"), constants);
        relations.push({
          field,
          target: targetNode ? stringOnly(targetNode, constants) ?? compact(targetNode.text) : null,
          kind: via === "m2m" ? "many" : "one",
          backref: relatedName === "+" || relatedName?.endsWith("+") ? "" : relatedName,
          backPopulates: null,
          backKind: null,
          via,
        });
        if (via !== "m2m") {
          if (LITERAL_TRUE(args.keywords.get("primary_key"))) hasPrimaryKey = true;
          columns.push(djangoColumn(field, `${field}_id`, callee, right, args, constants));
        }
        continue;
      }
      if (callee === "GenericForeignKey" || callee === "GenericRelation") continue;
      if (LITERAL_TRUE(args.keywords.get("primary_key"))) hasPrimaryKey = true;
      columns.push(djangoColumn(field, field, callee.replace(/Field$/u, ""), right, args, constants));
      continue;
    }
    if (libraries.hasDjango && right?.type === "call" && /Manager$|^Manager$|\.as_manager$/u.test(compact(right.childForFieldName("function")?.text ?? ""))) {
      managers.push(field);
      continue;
    }

    // SQLAlchemy / SQLModel fields.
    const mapped = annotation ? /^Mapped\[([\s\S]*)\]$/u.exec(annotation.text.trim())?.[1]?.trim() ?? null : null;
    if (callee === "relationship" || callee === "Relationship") {
      sqlFields += 1;
      if (callee === "relationship") sqlalchemyStyle = true;
      const args = right!.type === "call" ? argsOf(right!) : { positional: [], keywords: new Map<string, SyntaxNode>() };
      const targetNode = args.positional[0] ?? args.keywords.get("argument");
      const annotationTarget = relationTarget(mapped ?? annotation?.text ?? null);
      const backref = args.keywords.get("backref");
      let backrefName: string | null = null;
      let backKind: "one" | "many" | null = null;
      if (backref) {
        const backrefCall = unwrap(backref);
        backrefName = backrefCall?.type === "call" ? stringOnly(argsOf(backrefCall).positional[0], constants) : stringOnly(backref, constants);
        const backUselist = backrefCall?.type === "call" ? argsOf(backrefCall).keywords.get("uselist") : undefined;
        if (backUselist) backKind = LITERAL_TRUE(backUselist) ? "many" : "one";
      }
      const uselist = args.keywords.get("uselist");
      let kind: "one" | "many" | null = null;
      if (uselist) kind = LITERAL_TRUE(uselist) ? "many" : "one";
      else if (args.keywords.has("secondary")) kind = "many";
      else if (annotationTarget) kind = annotationTarget.list ? "many" : "one";
      relations.push({
        field,
        target: targetNode ? stringOnly(targetNode, constants) ?? compact(targetNode.text) : annotationTarget?.name ?? null,
        kind,
        backref: backrefName,
        backPopulates: stringOnly(args.keywords.get("back_populates"), constants),
        backKind,
        via: args.keywords.has("secondary") ? "m2m" : "relationship",
      });
      continue;
    }
    if (callee === "Column" || callee === "mapped_column" || callee === "Field" || (mapped !== null && right === null)) {
      if (callee === "Field" && !libraries.hasSqlModel) continue;
      if (callee === "Column" || callee === "mapped_column" || mapped !== null) sqlalchemyStyle = true;
      // A bare `Mapped[Other]` / `Mapped[list[Other]]` is a relationship, a bare `Mapped[int]` a column.
      if (mapped !== null && right === null) {
        const target = relationTarget(mapped);
        if (target && !/^(?:int|str|float|bool|bytes|date|datetime|time|Decimal|UUID|dict|Any|object|list|set|tuple|Enum)$/u.test(target.name) && /^["']?[A-Z]/u.test(target.name) && target.list) {
          relations.push({ field, target: target.name, kind: "many", backref: null, backPopulates: null, backKind: null, via: "relationship" });
          sqlFields += 1;
          continue;
        }
      }
      sqlFields += 1;
      const column = right?.type === "call" ? columnOf(right, field, annotation?.text ?? null, constants) : { name: field, column: field, type: typeOf(annotation?.text ?? null), optional: isOptional(annotation?.text ?? null), list: false, isId: false, isUnique: false };
      if (column) {
        if (column.isId) hasPrimaryKey = true;
        columns.push(column);
      }
      continue;
    }
    // SQLModel: an annotated attribute of a table class.
    if (libraries.hasSqlModel && annotation && !callee && right?.type !== "call") {
      const relation = relationTarget(annotation.text);
      if (!relation || !/^["']?[A-Z]/u.test(relation.name) || /^(?:int|str|float|bool|bytes|datetime|date|UUID|Decimal|dict|Any)$/u.test(relation.name)) {
        sqlFields += 1;
        columns.push({ name: field, column: field, type: typeOf(annotation.text), optional: isOptional(annotation.text) || right?.text === "None", list: false, isId: false, isUnique: false });
      }
    }
  }
  void posix;

  const isDjango = libraries.hasDjango && (djangoFields > 0 || bases.some((base) => /(?:^|\.)Model$/u.test(base))) && !bases.some((base) => /Serializer$/u.test(base));
  const isSqlModel = libraries.hasSqlModel && (tableTrue || bases.some((base) => /(?:^|\.)SQLModel$/u.test(base)) || sqlFields > 0);
  const isSqlAlchemy = libraries.hasSqlAlchemy && (tablename !== null || sqlFields > 0);
  if (!isDjango && !isSqlModel && !isSqlAlchemy) return null;
  if (columns.length === 0 && relations.length === 0 && tablename === null && !isDjango) return null;
  const library = isDjango ? "django" : isSqlModel && !sqlalchemyStyle && tablename === null ? "sqlmodel" : "sqlalchemy";
  return { name, line: definition.startPosition.row + 1, library, bases, tablename, tableTrue, abstract, proxy, appLabel, columns, relations, hasPrimaryKey, managers };
}

function djangoColumn(field: string, defaultColumn: string, type: string, call: SyntaxNode, args: ReturnType<typeof argsOf>, constants: ReadonlyMap<string, string>): PyColumn {
  const column = stringOnly(args.keywords.get("db_column"), constants) ?? defaultColumn;
  const primary = LITERAL_TRUE(args.keywords.get("primary_key"));
  const reference = type === "ForeignKey" || type === "OneToOneField" ? (args.positional[0] ?? args.keywords.get("to")) : undefined;
  void call;
  return {
    name: field,
    column,
    type,
    optional: LITERAL_TRUE(args.keywords.get("null")),
    list: false,
    isId: primary,
    isUnique: primary || LITERAL_TRUE(args.keywords.get("unique")) || type === "OneToOneField",
    ...(reference ? { references: stringOnly(reference, constants) ?? compact(reference.text) } : {}),
  };
}

// `Column("x", Integer, ForeignKey("t.id"), primary_key=True)`,
// `mapped_column(...)` and SQLModel `Field(...)`.
function columnOf(call: SyntaxNode, field: string, annotation: string | null, constants: ReadonlyMap<string, string>): PyColumn | null {
  const { positional, keywords } = argsOf(call);
  const callee = lastSegment(compact(call.childForFieldName("function")?.text ?? ""));
  let name = field;
  let type: string | null = typeOf(annotation);
  let references: string | undefined;
  for (const [index, arg] of positional.entries()) {
    const literal = stringOnly(arg, constants);
    if (literal !== null && index === 0 && callee !== "Field") {
      name = literal;
      continue;
    }
    const inner = unwrap(arg);
    if (inner?.type === "call") {
      const innerName = lastSegment(compact(inner.childForFieldName("function")?.text ?? ""));
      if (innerName === "ForeignKey") references = stringOnly(argsOf(inner).positional[0], constants) ?? undefined;
      else if (callee !== "Field") type = innerName;
    } else if (inner && (inner.type === "identifier" || inner.type === "attribute") && callee !== "Field") {
      const text = lastSegment(compact(inner.text));
      if (/^[A-Z]/u.test(text)) type = text;
    }
  }
  const foreignKey = keywords.get("foreign_key");
  if (foreignKey) references = stringOnly(foreignKey, constants) ?? references;
  const primary = LITERAL_TRUE(keywords.get("primary_key"));
  const nullable = keywords.get("nullable");
  const optional = nullable ? LITERAL_TRUE(nullable) : annotation !== null ? isOptional(annotation) : !primary;
  const column = stringOnly(keywords.get("name"), constants) ?? name;
  return {
    name: field === "" ? name : field,
    column: field === "" ? name : column === field ? name : column,
    type,
    optional: primary ? false : optional,
    list: false,
    isId: primary,
    isUnique: LITERAL_TRUE(keywords.get("unique")),
    ...(references ? { references } : {}),
  };
}

// The model a query chain ends in one row of: `Model.query.filter(..).first()`,
// `Model.objects.get(..)`, `session.query(Model).filter(..).one()`.
const ROW_METHODS = new Set(["first", "one", "one_or_none", "get", "get_or_404", "first_or_404", "last", "latest", "earliest", "scalar", "scalar_one", "scalar_one_or_none"]);
function rowModel(call: SyntaxNode): string | null {
  let current: SyntaxNode | null = unwrap(call);
  if (current?.type !== "call") return null;
  const last = current.childForFieldName("function");
  if (last?.type !== "attribute" || !ROW_METHODS.has(last.childForFieldName("attribute")?.text ?? "")) return null;
  // Walk to the start of the chain.
  while (current) {
    if (current.type === "call") {
      const callee: SyntaxNode | null = current.childForFieldName("function");
      if (callee?.type === "attribute") {
        const object = callee.childForFieldName("object");
        const name = callee.childForFieldName("attribute")?.text;
        const objectText = compact(object?.text ?? "");
        if (name === "query" && /session|^db$|sess/iu.test(objectText.split(".").at(-1) ?? "")) {
          const model = argsOf(current).positional[0];
          return model && /^[A-Za-z_][\w.]*$/u.test(compact(model.text)) ? compact(model.text) : null;
        }
        current = object;
        continue;
      }
      return null;
    }
    if (current.type === "attribute") {
      const attribute = current.childForFieldName("attribute")?.text;
      const owner = compact(current.childForFieldName("object")?.text ?? "");
      if ((attribute === "query" || attribute === "objects") && /^[A-Za-z_][\w.]*$/u.test(owner) && /^[A-Z]/u.test(lastSegment(owner))) return owner;
      current = current.childForFieldName("object");
      continue;
    }
    return null;
  }
  return null;
}

function typeOf(annotation: string | null): string | null {
  if (!annotation) return null;
  const inner = /^Mapped\[([\s\S]*)\]$/u.exec(annotation.trim())?.[1] ?? annotation;
  return inner.replace(/^Optional\[(.*)\]$/su, "$1").replace(/\s*\|\s*None$/u, "").replace(/^None\s*\|\s*/u, "").trim() || null;
}

function isOptional(annotation: string | null): boolean {
  return annotation !== null && /\bOptional\[|\|\s*None\b|\bNone\s*\|/u.test(annotation);
}

// The class an annotation names, and whether it is a list of it:
// `list["Item"]`, `List[Item]`, `Mapped[list[Item]]`, `Item | None`.
function relationTarget(annotation: string | null): { name: string; list: boolean } | null {
  if (!annotation) return null;
  let text = annotation.trim().replace(/^Mapped\[([\s\S]*)\]$/u, "$1").trim();
  text = text.replace(/^Optional\[(.*)\]$/su, "$1").replace(/\s*\|\s*None$/u, "").replace(/^None\s*\|\s*/u, "").trim();
  const list = /^(?:typing\.)?(?:list|List|Set|set|Sequence|Collection|Iterable)\[([\s\S]*)\]$/u.exec(text);
  const inner = (list ? list[1]! : text).trim().replace(/^["']|["']$/gu, "");
  return /^[A-Za-z_][\w.]*$/u.test(inner) ? { name: inner, list: list !== null } : null;
}

// ---- migrations -------------------------------------------------------------

function readAlembic(root: SyntaxNode, constants: ReadonlyMap<string, string>, facts: PyDataFacts): void {
  for (const call of root.descendantsOfType("call")) {
    const callee = compact(call.childForFieldName("function")?.text ?? "");
    const match = /^(?:op|alembic\.op)\.(create_table|add_column|drop_column|drop_table)$/u.exec(callee);
    if (!match) continue;
    const { positional } = argsOf(call);
    const table = stringOnly(positional[0], constants);
    if (table === null) continue;
    const line = call.startPosition.row + 1;
    const op = match[1]!;
    if (op === "create_table") {
      const columns = positional.slice(1).flatMap((arg) => (arg.type === "call" && lastSegment(compact(arg.childForFieldName("function")?.text ?? "")) === "Column" ? [columnOf(arg, "", null, constants)] : []));
      facts.migrations.push({ kind: "alembic", op, table, model: null, line, columns: columns.filter((column): column is PyColumn => column !== null), column: null, options: {} });
    } else if (op === "add_column") {
      const column = positional[1]?.type === "call" ? columnOf(positional[1], "", null, constants) : null;
      facts.migrations.push({ kind: "alembic", op, table, model: null, line, columns: column ? [column] : [], column: column?.name ?? null, options: {} });
    } else if (op === "drop_column") {
      facts.migrations.push({ kind: "alembic", op, table, model: null, line, columns: [], column: stringOnly(positional[1], constants), options: {} });
    } else {
      facts.migrations.push({ kind: "alembic", op, table, model: null, line, columns: [], column: null, options: {} });
    }
  }
}

function readDjangoMigration(root: SyntaxNode, constants: ReadonlyMap<string, string>, facts: PyDataFacts, posix: string): void {
  const parts = posix.split("/");
  const at = parts.lastIndexOf("migrations");
  const app = at > 0 ? parts[at - 1]! : null;
  if (!app) return;
  const fieldColumn = (name: string, node: SyntaxNode | undefined): PyColumn | null => {
    const field = unwrap(node);
    if (field?.type !== "call") return null;
    const type = lastSegment(compact(field.childForFieldName("function")?.text ?? ""));
    if (type === "ManyToManyField") return null;
    const args = argsOf(field);
    return djangoColumn(name, type === "ForeignKey" || type === "OneToOneField" ? `${name}_id` : name, type.replace(/Field$/u, ""), field, args, constants);
  };
  for (const call of root.descendantsOfType("call")) {
    const callee = lastSegment(compact(call.childForFieldName("function")?.text ?? ""));
    if (!/^(?:CreateModel|AddField|RemoveField|DeleteModel)$/u.test(callee) || !compact(call.childForFieldName("function")?.text ?? "").includes("migrations.")) continue;
    const { positional, keywords } = argsOf(call);
    const line = call.startPosition.row + 1;
    if (callee === "CreateModel") {
      const model = stringOnly(keywords.get("name") ?? positional[0], constants);
      if (model === null) continue;
      const columns: PyColumn[] = [];
      const fields = unwrap(keywords.get("fields") ?? positional[1]);
      for (const item of fields?.namedChildren ?? []) {
        if (item.type !== "tuple") continue;
        const [nameNode, fieldNode] = item.namedChildren;
        const name = stringOnly(nameNode, constants);
        const column = name === null ? null : fieldColumn(name, fieldNode);
        if (column) columns.push(column);
      }
      const options: Record<string, string> = {};
      const optionNode = unwrap(keywords.get("options"));
      for (const pair of optionNode?.namedChildren ?? []) {
        if (pair.type === "pair" && stringOnly(pair.childForFieldName("key")) === "db_table") {
          const value = stringOnly(pair.childForFieldName("value"), constants);
          if (value !== null) options.db_table = value;
        }
      }
      facts.migrations.push({ kind: "django", op: "create_model", table: app, model, line, columns, column: null, options });
    } else if (callee === "AddField") {
      const model = stringOnly(keywords.get("model_name"), constants);
      const name = stringOnly(keywords.get("name"), constants);
      const column = name === null ? null : fieldColumn(name, keywords.get("field"));
      if (model !== null && name !== null) facts.migrations.push({ kind: "django", op: "add_field", table: app, model, line, columns: column ? [column] : [], column: name, options: {} });
    } else if (callee === "RemoveField") {
      const model = stringOnly(keywords.get("model_name"), constants);
      const name = stringOnly(keywords.get("name"), constants);
      if (model !== null && name !== null) facts.migrations.push({ kind: "django", op: "remove_field", table: app, model, line, columns: [], column: name, options: {} });
    } else {
      const model = stringOnly(keywords.get("name"), constants);
      if (model !== null) facts.migrations.push({ kind: "django", op: "delete_model", table: app, model, line, columns: [], column: null, options: {} });
    }
  }
}

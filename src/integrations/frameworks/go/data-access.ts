import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GoParsePlugin } from "../../languages/go/parser.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createGoCallIndex, firstResultType, resolveGoCall, resolveType } from "../../../core/scan/resolution/go-calls.js";
import { importedPackages } from "./routes.js";
import { sqlTableAccesses } from "./sql.js";

// Go data access: gorm, database/sql and sqlx.
//
// The parse records each call chain that ends in a data method
// (`db.Model(&Article{}).Where(…).Count(&n)`, `db.QueryRow("SELECT …")`):
// where the chain starts (a typed value, a constructor's result, a struct
// field, a package variable; chains a local was assigned from are followed)
// and each method with what its arguments are (a literal, a type). Once every
// file is parsed the start is resolved to a gorm, database/sql or sqlx value
// (`common.GetDB()` returns `*gorm.DB`), and the chain becomes ACCESSES_DATA
// to a DataModel:
//   - gorm: the struct of `Model(&X{})`, else of the method's value
//     (`First(&user)`, `Delete(&X{})`), else of a `Where(X{…})` condition;
//     `Association("Tags")` reaches the field's model, `Preload("Author")`
//     reads the related models. A model's table is its `TableName()` literal
//     or gorm's name (`ArticleModel` → `article_models`); relations between
//     model structs are RELATES_TO. `Raw` / `Exec` SQL is read for tables.
//   - database/sql and sqlx: the tables of the literal SQL, each a DataModel
//     of the library named by its table (a gorm model with that table when
//     there is one).
// READS / WRITES to the tables follow from the JS/TS data-access contributor,
// which runs after this one.

type Arg = { literal?: string; type?: string; field?: { type: string; name: string } };
type Step = { method: string; args: Arg[] };
type Root = { type: string } | { factory: string } | { field: { type: string; name: string } } | { packageVar: string; qualifier?: string };
// `own`: how many of the last steps the call itself writes (the others come
// from what its start was assigned from).
type Chain = { root: Root; steps: Step[]; own?: number };
type GormStruct = { tags: Record<string, string>; embedsModel: boolean };

const GORM_PACKAGES = new Set(["gorm.io/gorm", "github.com/jinzhu/gorm"]);
const SQL_PACKAGE = "database/sql";
const SQLX_PACKAGE = "github.com/jmoiron/sqlx";

const gormOperations = new Map<string, string>([
  ["Find", "read"], ["First", "read"], ["Last", "read"], ["Take", "read"], ["Scan", "read"], ["Count", "read"],
  ["Pluck", "read"], ["Rows", "read"], ["Row", "read"], ["FirstOrInit", "read"], ["FindInBatches", "read"],
  ["Create", "create"], ["CreateInBatches", "create"],
  ["Save", "upsert"], ["FirstOrCreate", "upsert"],
  ["Update", "update"], ["Updates", "update"], ["UpdateColumn", "update"], ["UpdateColumns", "update"],
  ["Delete", "delete"],
]);
// Methods whose value names the model (`First(&user)`, `Delete(&X{})`).
const gormValueMethods = new Set(["Find", "First", "Last", "Take", "FirstOrInit", "FindInBatches", "Create", "CreateInBatches", "Save", "FirstOrCreate", "Updates", "Delete"]);
const gormConditionMethods = new Set(["Where", "Not", "Or", "Attrs", "Assign"]);
const associationOperations = new Map([["Find", "read"], ["Count", "read"], ["Append", "update"], ["Replace", "update"], ["Delete", "update"], ["Clear", "update"]]);
// database/sql and sqlx methods that take SQL.
const sqlMethods = new Set([
  "Query", "QueryContext", "QueryRow", "QueryRowContext", "Exec", "ExecContext", "Prepare", "PrepareContext",
  "Get", "GetContext", "Select", "SelectContext", "Queryx", "QueryxContext", "QueryRowx", "QueryRowxContext",
  "NamedExec", "NamedExecContext", "NamedQuery", "NamedQueryContext", "MustExec", "MustExecContext",
  "Preparex", "PreparexContext", "PrepareNamed", "PrepareNamedContext",
]);
const chainMethods = new Set([...gormOperations.keys(), ...sqlMethods, "AutoMigrate", "Association", "Raw"]);

const FUNCTION_TYPES = new Set(["function_declaration", "method_declaration", "func_literal"]);
const MAX_DEPTH = 6;

export const goDataAccessPlugin: GoParsePlugin = ({ fileNodeId, root, nodes }) => {
  const imports = importedPackages(root);
  const aliases = new Set(imports.values());
  const gorm = [...GORM_PACKAGES].map((source) => imports.get(source)).find((alias) => alias !== undefined);
  const constants = stringConstants(root);
  const nodesInFile = nodes.filter((node) => node.id.startsWith(`${fileNodeId}:`));
  const calls = new Map<string, GraphNode>();
  for (const node of nodesInFile) {
    if (node.label === "Call") calls.set(`${node.properties.line}:${node.properties.columnNumber}:${node.properties.expression}`, node);
  }

  const literal = (node: SyntaxNode): string | undefined => {
    if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") return node.text.slice(1, -1);
    if (node.type === "identifier") return constants.get(node.text);
    if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      const [a, b] = [left ? literal(left) : undefined, right ? literal(right) : undefined];
      return a !== undefined && b !== undefined ? a + b : undefined;
    }
    return undefined;
  };

  // What a name holds at a point: its type, or the expression it was last
  // assigned before the point (in the functions around it, else at package
  // level).
  const definitionOf = (name: string, at: SyntaxNode): { type: string } | { value: SyntaxNode } | null => {
    for (let scope = at.parent; scope; scope = scope.parent) {
      if (!FUNCTION_TYPES.has(scope.type)) continue;
      let best: { start: number; result: { type: string } | { value: SyntaxNode } | null } | null = null;
      for (const list of [scope.childForFieldName("receiver"), scope.childForFieldName("parameters")]) {
        for (const parameter of list?.namedChildren ?? []) {
          const type = parameter.childForFieldName("type")?.text;
          if (type && parameter.childrenForFieldName("name").some((id) => id.text === name)) best = { start: -1, result: { type } };
        }
      }
      const body = scope.childForFieldName("body");
      for (const node of body ? [body, ...body.descendantsOfType(["short_var_declaration", "assignment_statement", "var_spec"])] : []) {
        if (node.startIndex >= at.startIndex || same(node, body!)) continue;
        if (!visibleFrom(node, at, scope)) continue;
        const result = assignmentOf(node, name);
        if (result !== undefined && (!best || node.startIndex > best.start)) best = { start: node.startIndex, result };
      }
      if (best) return best.result;
    }
    for (const spec of root.descendantsOfType("var_spec")) {
      if (!isPackageLevel(spec)) continue;
      const result = assignmentOf(spec, name);
      if (result !== undefined) return result;
    }
    return null;
  };

  const typeOf = (expression: SyntaxNode, depth: number): string | undefined => {
    if (depth > MAX_DEPTH) return undefined;
    if (expression.type === "unary_expression") {
      const operand = expression.childForFieldName("operand");
      return operand ? typeOf(operand, depth + 1) : undefined;
    }
    if (expression.type === "parenthesized_expression" && expression.namedChildren[0]) return typeOf(expression.namedChildren[0], depth + 1);
    const literalType = valueTypeText(expression);
    if (literalType) return literalType;
    if (expression.type !== "identifier") return undefined;
    const definition = definitionOf(expression.text, expression);
    if (!definition) return undefined;
    return "type" in definition ? definition.type : typeOf(definition.value, depth + 1);
  };

  const argument = (node: SyntaxNode): Arg => {
    const value = literal(node);
    if (value !== undefined) return { literal: value };
    const inner = node.type === "unary_expression" ? node.childForFieldName("operand") ?? node : node;
    if (inner.type === "selector_expression") {
      const operand = inner.childForFieldName("operand");
      const type = operand ? typeOf(operand, 0) : undefined;
      const field = inner.childForFieldName("field")?.text;
      if (type && field) return { field: { type, name: field } };
    }
    const type = typeOf(node, 0);
    return type ? { type } : {};
  };

  const decompose = (expression: SyntaxNode, depth: number): Chain | null => {
    if (depth > MAX_DEPTH) return null;
    const steps: Step[] = [];
    let current = expression;
    while (current.type === "call_expression") {
      const fn = current.childForFieldName("function");
      if (fn?.type === "identifier") {
        // A local closure: `query, ok := buildQuery()` holds what it returns first.
        const local = definitionOf(fn.text, fn);
        const result = local && "value" in local && local.value.type === "func_literal" ? firstResultType(local.value.childForFieldName("result")?.text) : null;
        return { root: result ? { type: result } : { factory: fn.text }, steps };
      }
      if (fn?.type !== "selector_expression") return null;
      const operand = fn.childForFieldName("operand")!;
      const field = fn.childForFieldName("field")!.text;
      if (operand.type === "identifier" && aliases.has(operand.text) && !definitionOf(operand.text, operand)) {
        return { root: { factory: `${operand.text}.${field}` }, steps };
      }
      steps.unshift({ method: field, args: (current.childForFieldName("arguments")?.namedChildren ?? []).map(argument) });
      current = operand;
    }
    if (current.type === "identifier") {
      const definition = definitionOf(current.text, current);
      if (!definition) return { root: { packageVar: current.text }, steps };
      if ("type" in definition) return { root: { type: definition.type }, steps };
      const type = valueTypeText(definition.value);
      if (type) return { root: { type }, steps };
      const inner = decompose(definition.value, depth + 1);
      return inner ? { root: inner.root, steps: [...inner.steps, ...steps] } : null;
    }
    if (current.type === "selector_expression") {
      const operand = current.childForFieldName("operand");
      const field = current.childForFieldName("field")?.text;
      if (operand?.type !== "identifier" || !field) return null;
      if (aliases.has(operand.text) && !definitionOf(operand.text, operand)) return { root: { packageVar: field, qualifier: operand.text }, steps };
      const type = typeOf(operand, depth + 1);
      return type ? { root: { field: { type, name: field } }, steps } : null;
    }
    return null;
  };

  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression" || isChained(call)) continue;
    const chain = decompose(call, 0);
    const own = chain ? ownSteps(fn) : 0;
    if (!chain || !chain.steps.slice(-own).some((step) => chainMethods.has(step.method))) continue;
    chain.own = own;
    const node = calls.get(`${call.startPosition.row + 1}:${call.startPosition.column}:${fn.text}`);
    if (node) node.properties.goDataAccess = JSON.stringify(chain);
  }

  // gorm structs: their `gorm:"…"` tags and whether they embed gorm.Model;
  // structs declared inside a function are not models.
  for (const spec of root.descendantsOfType("type_spec")) {
    const type = spec.childForFieldName("type");
    const name = spec.childForFieldName("name")?.text;
    if (type?.type !== "struct_type" || !name) continue;
    const classNode = nodesInFile.find((node) => node.label === "Class" && node.properties.name === name && node.properties.line === spec.startPosition.row + 1);
    if (!classNode) continue;
    if (insideFunction(spec)) {
      classNode.properties.goLocalType = true;
      continue;
    }
    if (!gorm) continue;
    const struct: GormStruct = { tags: {}, embedsModel: false };
    const list = type.namedChildren.find((child) => child.type === "field_declaration_list");
    for (const declaration of list?.namedChildren ?? []) {
      if (declaration.type !== "field_declaration") continue;
      const fieldType = declaration.childForFieldName("type")?.text ?? "";
      const names = declaration.childrenForFieldName("name");
      if (names.length === 0 && fieldType.replace(/^\*/u, "") === `${gorm}.Model`) struct.embedsModel = true;
      const tag = /(?:^|\s)gorm:"([^"]*)"/u.exec(declaration.childForFieldName("tag")?.text.slice(1, -1) ?? "")?.[1];
      if (tag !== undefined) for (const fieldName of names) struct.tags[fieldName.text] = tag;
    }
    if (struct.embedsModel || Object.keys(struct.tags).length > 0) classNode.properties.goGorm = JSON.stringify(struct);
  }

  // `func (Article) TableName() string { return "posts" }`.
  for (const method of root.descendantsOfType("method_declaration")) {
    if (method.childForFieldName("name")?.text !== "TableName") continue;
    const statements = method.childForFieldName("body")?.descendantsOfType("return_statement") ?? [];
    const value = statements.length === 1 ? statements[0]!.namedChildren[0]?.namedChildren[0] ?? statements[0]!.namedChildren[0] : undefined;
    const table = value ? literal(value) : undefined;
    const functionNode = nodesInFile.find((node) => node.label === "Function" && node.properties.name === "TableName" && node.properties.line === method.startPosition.row + 1);
    if (table && functionNode) functionNode.properties.goTableName = table;
  }

  // Package variables: what they hold (`var DB *gorm.DB`, `var db = Open()`).
  for (const spec of root.descendantsOfType("var_spec")) {
    if (!isPackageLevel(spec)) continue;
    const type = spec.childForFieldName("type")?.text;
    const values = spec.childForFieldName("value")?.namedChildren ?? [];
    spec.childrenForFieldName("name").forEach((name, index) => {
      const variable = nodesInFile.find((node) => node.label === "Variable" && node.properties.name === name.text && node.properties.line === name.startPosition.row + 1);
      if (!variable) return;
      const value = values[index] ?? (values.length === 1 ? values[0] : undefined);
      const chain = type ? { root: { type }, steps: [] } : value ? decompose(value, 0) : null;
      if (chain && chain.steps.length === 0) variable.properties.goVarRoot = JSON.stringify(chain.root);
    });
  }
};

type Access = { callId: string; modelId: string; operation: string; library: string; line: GraphNode["properties"][string]; expression: GraphNode["properties"][string] };
type ModelRef = { classNode: GraphNode; fileId: string; pkg: string };

export const goDataAccessContributor: ISemanticContributor = {
  contribute(graph) {
    const pending = graph.nodes.filter((node) => node.label === "Call" && typeof node.properties.goDataAccess === "string");
    const gormClasses = graph.nodes.filter((node) => node.label === "Class" && typeof node.properties.goGorm === "string");
    const cleanup = () => {
      for (const node of graph.nodes) {
        delete node.properties.goDataAccess;
        delete node.properties.goGorm;
        delete node.properties.goLocalType;
        delete node.properties.goTableName;
        delete node.properties.goVarRoot;
      }
    };
    if (pending.length === 0 && gormClasses.length === 0) {
      cleanup();
      return;
    }

    const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
    const goIndex = createGoCallIndex(graph, relationshipIndex);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const fileOfFunction = (id: string) => relationshipIndex.fileByFunctionId.get(id) ?? goIndex.fileByFunctionId.get(id) ?? null;
    const relativePath = (fileId: string) => String(nodeById.get(fileId)?.properties.relativePath ?? fileId.slice("file:".length));

    // Imported package sources per file by local name.
    const sourcesByFile = new Map<string, Map<string, string>>();
    for (const relationship of graph.relationships) {
      if (relationship.type !== "IMPORTS" || !relationship.from.endsWith(".go")) continue;
      const imported = nodeById.get(relationship.to);
      const source = imported?.properties.source;
      if (imported?.label !== "Import" || typeof source !== "string") continue;
      const alias = typeof imported.properties.alias === "string" ? imported.properties.alias : defaultPackageName(source);
      const map = sourcesByFile.get(relationship.from) ?? new Map<string, string>();
      map.set(alias, source);
      sourcesByFile.set(relationship.from, map);
    }

    const libraryOfType = (text: string, fileId: string): string | null => {
      const base = text.trim().replace(/^[*[\]]+/u, "");
      const dot = base.indexOf(".");
      if (dot === -1) return null;
      const source = sourcesByFile.get(fileId)?.get(base.slice(0, dot));
      const name = base.slice(dot + 1);
      if (source && GORM_PACKAGES.has(source) && name === "DB") return "gorm";
      if (source === SQL_PACKAGE && ["DB", "Tx", "Conn", "Stmt"].includes(name)) return "database/sql";
      if (source === SQLX_PACKAGE && ["DB", "Tx", "Conn", "Stmt", "NamedStmt"].includes(name)) return "sqlx";
      return null;
    };

    const variables = new Map<string, { node: GraphNode; fileId: string }>();
    for (const node of graph.nodes) {
      if (node.label !== "Variable" || typeof node.properties.goVarRoot !== "string") continue;
      const fileId = node.id.slice(0, node.id.indexOf(":variable:"));
      const pkg = goIndex.packageByFile.get(fileId);
      if (pkg !== undefined) variables.set(`${pkg}\0${node.properties.name}`, { node, fileId });
    }

    const libraryOfRoot = (root: Root, fileId: string, depth: number): string | null => {
      if (depth > MAX_DEPTH) return null;
      if ("type" in root) return libraryOfType(root.type, fileId);
      if ("factory" in root) {
        const [qualifier, name] = root.factory.includes(".") ? root.factory.split(".") as [string, string] : [null, root.factory];
        const source = qualifier === null ? undefined : sourcesByFile.get(fileId)?.get(qualifier);
        if (source && GORM_PACKAGES.has(source)) return name === "Open" ? "gorm" : null;
        if (source === SQL_PACKAGE) return name === "Open" || name === "OpenDB" ? "database/sql" : null;
        if (source === SQLX_PACKAGE) return /^(?:Open|Connect|ConnectContext|MustConnect|MustOpen|NewDb)$/u.test(name) ? "sqlx" : null;
        const call: GraphNode = { id: `${fileId}:dataroot:${root.factory}`, label: "Call", properties: { expression: root.factory, callee: name, receiver: qualifier } };
        for (const target of resolveGoCall(call, fileId, goIndex)) {
          const fn = nodeById.get(target.functionId);
          const result = firstResultType(fn?.properties.returnType);
          const fnFile = fileOfFunction(target.functionId);
          if (result && fnFile) return libraryOfType(result, fnFile);
        }
        return null;
      }
      if ("field" in root) {
        const owner = classOf(root.field.type, fileId);
        const field = owner ? fieldsOf(owner.classNode).find((candidate) => candidate.name === root.field.name) : undefined;
        return owner && field ? libraryOfType(field.type, owner.fileId) : null;
      }
      const pkgs = root.qualifier ? goIndex.importsByFile.get(fileId)?.get(root.qualifier) ?? [] : [goIndex.packageByFile.get(fileId) ?? ""];
      for (const pkg of pkgs) {
        const variable = variables.get(`${pkg}\0${root.packageVar}`);
        if (variable) return libraryOfRoot(JSON.parse(String(variable.node.properties.goVarRoot)) as Root, variable.fileId, depth + 1);
      }
      return null;
    };

    const classOf = (type: string, fileId: string): ModelRef | null => {
      const ref = resolveType(type.trim().replace(/^[*[\]]+/u, "").replace(/^\*/u, ""), fileId, goIndex);
      if (!ref || ref.anonymous) return null;
      const found = goIndex.typesByPackage.get(ref.pkg)?.get(ref.name);
      if (!found || found.node.properties.goLocalType === true) return null;
      return { classNode: found.node, fileId: found.fileId, pkg: ref.pkg };
    };

    // gorm models: DataModel and Table, created on first use.
    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    const models = new Map<string, { id: string; ref: ModelRef; table: string }>();
    const tables = new Set<string>();
    const table = (name: string, library: string) => {
      const id = `table:go:-:${name}`;
      if (!tables.has(id)) {
        tables.add(id);
        nodes.push({ id, label: "Table", properties: { name, kind: "table", library, schemaName: null, provider: null, declaredIn: null, line: null, columns: "[]" } });
      }
      return id;
    };
    const gormModel = (ref: ModelRef) => {
      const existing = models.get(ref.classNode.id);
      if (existing) return existing;
      const name = String(ref.classNode.properties.name);
      const tableMethod = goIndex.methodsByPackage.get(ref.pkg)?.get(`${name}.TableName`);
      const tableName = (tableMethod ? nodeById.get(tableMethod)?.properties.goTableName : undefined) as string | undefined ?? gormTableName(name);
      const directory = path.posix.dirname(relativePath(ref.fileId));
      const model = { id: `datamodel:gorm:${directory}:${name}`, ref, table: tableName };
      models.set(ref.classNode.id, model);
      nodes.push({ id: model.id, label: "DataModel", properties: { name, library: "gorm", declaredIn: relativePath(ref.fileId), line: ref.classNode.properties.line ?? null } });
      relationships.push({ from: model.id, to: table(tableName, "gorm"), type: "MAPS_TO_TABLE", properties: {} });
      return model;
    };
    for (const node of gormClasses) {
      const fileId = relationshipIndex.fileByClassId.get(node.id);
      const pkg = fileId ? goIndex.packageByFile.get(fileId) : undefined;
      if (fileId && pkg !== undefined && node.properties.goLocalType !== true) gormModel({ classNode: node, fileId, pkg });
    }

    // A model's field that holds another model (`Tags []TagModel`).
    const fieldModel = (model: ModelRef, field: string) => {
      const found = fieldsOf(model.classNode).find((candidate) => candidate.name === field);
      return found ? classOf(found.type, model.fileId) : null;
    };

    const accesses: Access[] = [];
    const sqlCalls: Array<{ call: GraphNode; sql: string; library: string }> = [];
    for (const call of pending) {
      const chain = JSON.parse(String(call.properties.goDataAccess)) as Chain;
      const fileId = /^(file:.+?\.go)(?=:)/u.exec(call.id)?.[1];
      if (!fileId) continue;
      const library = libraryOfRoot(chain.root, fileId, 0);
      if (!library) continue;
      const add = (modelId: string, operation: string) => {
        accesses.push({ callId: call.id, modelId, operation, library, line: call.properties.line, expression: call.properties.expression });
      };
      const steps = chain.steps;
      const terminal = steps[steps.length - 1]!;
      // `Preload("Author.UserModel")` reads each model on the path from the
      // model the query loads.
      const preload = (model: ModelRef) => {
        for (const step of steps) {
          if (step.method !== "Preload" || !step.args[0]?.literal) continue;
          let current: ModelRef | null = model;
          for (const segment of step.args[0].literal.split(".")) {
            current = current ? fieldModel(current, segment) : null;
            if (current) add(gormModel(current).id, "read");
          }
        }
      };

      if (library !== "gorm") {
        // `db.QueryRow("SELECT …").Scan(&x)`: the method that takes the SQL.
        const sqlStep = steps.slice(-(chain.own ?? steps.length)).find((step) => sqlMethods.has(step.method));
        if (!sqlStep) continue;
        const sql = sqlStep.args.find((arg) => arg.literal !== undefined)?.literal;
        if (sql) sqlCalls.push({ call, sql, library });
        continue;
      }

      const migrate = steps.find((step) => step.method === "AutoMigrate");
      if (migrate) {
        for (const arg of migrate.args) {
          const ref = arg.type ? classOf(arg.type, fileId) : null;
          if (ref) gormModel(ref);
        }
        continue;
      }
      const raw = steps.find((step) => step.method === "Raw");
      if (raw || terminal.method === "Exec") {
        const sql = (raw ?? terminal).args[0]?.literal;
        if (sql) sqlCalls.push({ call, sql, library });
        continue;
      }

      // A call on a query's result (`rows.Scan` after `db.Model(…).Rows()`).
      if (steps.slice(0, steps.length - (chain.own ?? steps.length)).some((step) => gormOperations.has(step.method))) continue;
      const modelStep = steps.find((step) => step.method === "Model");
      const modelArg = modelStep?.args[0];
      const typed = (arg: Arg | undefined) => {
        if (arg?.type) return classOf(arg.type, fileId);
        if (arg?.field) {
          const owner = classOf(arg.field.type, fileId);
          return owner ? fieldModel(owner, arg.field.name) : null;
        }
        return null;
      };
      const baseModel = typed(modelArg);

      const association = steps.findIndex((step) => step.method === "Association");
      if (association !== -1) {
        const operation = associationOperations.get(terminal.method);
        const field = steps[association]!.args[0]?.literal;
        const target = baseModel && field ? fieldModel(baseModel, field) : null;
        if (operation && target) {
          add(gormModel(target).id, operation);
          if (operation === "read") preload(target);
        }
        continue;
      }

      const operation = gormOperations.get(terminal.method);
      if (!operation) continue;
      const tableStep = steps.find((step) => step.method === "Table")?.args[0]?.literal;
      let model = baseModel;
      if (!model && !tableStep && gormValueMethods.has(terminal.method)) model = typed(terminal.args[0]) ?? (terminal.method === "FirstOrCreate" ? typed(terminal.args[1]) : null);
      if (!model && !tableStep) {
        for (const step of steps) {
          if (gormConditionMethods.has(step.method)) model = typed(step.args[0]) ?? model;
          if (model) break;
        }
      }
      if (model) {
        add(gormModel(model).id, operation);
        if (operation === "read") preload(model);
      } else if (tableStep) {
        add(tableModel(tableStep, "gorm"), operation);
      }
    }

    // Literal SQL: a table that is a gorm model's is that model.
    const modelByTable = new Map([...models.values()].map((model) => [model.table, model.id]));
    function tableModel(name: string, library: string): string {
      const id = `datamodel:${library}:${name}`;
      if (!nodes.some((node) => node.id === id)) {
        nodes.push({ id, label: "DataModel", properties: { name, library } });
        relationships.push({ from: id, to: table(name, library), type: "MAPS_TO_TABLE", properties: {} });
      }
      return id;
    }
    for (const { call, sql, library } of sqlCalls) {
      for (const access of sqlTableAccesses(sql)) {
        const modelId = (library === "gorm" ? modelByTable.get(access.table) : undefined) ?? tableModel(access.table, library);
        accesses.push({ callId: call.id, modelId, operation: access.operation, library, line: call.properties.line, expression: call.properties.expression });
      }
    }

    // Relations between models: `Author ArticleUserModel`, `Tags []TagModel`
    // (`many2many:article_tags`), `foreignKey:` tags.
    for (const model of [...models.values()]) {
      const fields = fieldsOf(model.ref.classNode);
      const tags = typeof model.ref.classNode.properties.goGorm === "string" ? (JSON.parse(model.ref.classNode.properties.goGorm) as GormStruct).tags : {};
      for (const field of fields) {
        if (field.embedded) continue;
        const target = classOf(field.type, model.ref.fileId);
        if (!target || !models.has(target.classNode.id) && !isGormClass(target.classNode)) continue;
        const targetModel = gormModel(target);
        const many = /^\[\]/u.test(field.type.trim());
        const settings = gormTagSettings(tags[field.name] ?? "");
        const foreignKey = settings.get("foreignkey");
        const ownKey = fields.some((candidate) => candidate.name === `${field.name}ID`) ? `${field.name}ID` : null;
        const onDelete = /OnDelete:(\w+)/iu.exec(settings.get("constraint") ?? "")?.[1] ?? null;
        relationships.push({
          from: model.id,
          to: targetModel.id,
          type: "RELATES_TO",
          properties: {
            field: field.name,
            kind: many ? "many" : "one",
            fields: JSON.stringify(foreignKey ? [foreignKey] : !many && ownKey ? [ownKey] : []),
            references: JSON.stringify(settings.has("references") ? [settings.get("references")] : []),
            relationName: settings.get("many2many") ?? null,
            onDelete,
          },
        });
      }
    }

    // ACCESSES_DATA from the calling function, its routes and entrypoints,
    // and the functions that call it.
    const callerByCall = new Map<string, string>();
    const routesByFunction = new Map<string, string[]>();
    const entrypointsByFunction = new Map<string, string[]>();
    const callsByCaller = new Map<string, string[]>();
    const targetsByCall = new Map<string, string[]>();
    for (const relationship of graph.relationships) {
      if (relationship.type === "CALLS") {
        callerByCall.set(relationship.to, relationship.from);
        callsByCaller.set(relationship.from, [...callsByCaller.get(relationship.from) ?? [], relationship.to]);
      } else if (relationship.type === "ROUTE_HANDLED_BY") routesByFunction.set(relationship.to, [...routesByFunction.get(relationship.to) ?? [], relationship.from]);
      else if (relationship.type === "ENTRYPOINT_HANDLED_BY") entrypointsByFunction.set(relationship.to, [...entrypointsByFunction.get(relationship.to) ?? [], relationship.from]);
      else if (relationship.type === "CALL_RESOLVES_TO") targetsByCall.set(relationship.from, [...targetsByCall.get(relationship.from) ?? [], relationship.to]);
    }
    const accessesByFunction = new Map<string, Access[]>();
    const seen = new Set<string>();
    const record = (from: string, access: Access) => {
      const key = `${from}\0${access.modelId}\0${access.operation}\0${access.library}\0${access.line}\0${access.expression}`;
      if (seen.has(key)) return false;
      seen.add(key);
      relationships.push({ from, to: access.modelId, type: "ACCESSES_DATA", properties: { operation: access.operation, library: access.library, line: access.line, expression: access.expression } });
      return true;
    };
    for (const access of accesses) {
      const functionId = callerByCall.get(access.callId);
      if (!functionId) continue;
      if (record(functionId, access)) accessesByFunction.set(functionId, [...accessesByFunction.get(functionId) ?? [], access]);
      for (const source of [...routesByFunction.get(functionId) ?? [], ...entrypointsByFunction.get(functionId) ?? []]) record(source, access);
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
          if (!record(caller, access)) continue;
          accessesByFunction.set(caller, [...accessesByFunction.get(caller) ?? [], access]);
          for (const source of [...routesByFunction.get(caller) ?? [], ...entrypointsByFunction.get(caller) ?? []]) record(source, access);
          changed = true;
        }
        if (changed) queue.push(caller);
      }
    }

    cleanup();
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

function isGormClass(node: GraphNode): boolean {
  return typeof node.properties.goGorm === "string";
}

function fieldsOf(node: GraphNode): Array<{ name: string; type: string; embedded?: true }> {
  try {
    const parsed = JSON.parse(String(node.properties.fields ?? "[]")) as unknown;
    return Array.isArray(parsed) ? parsed as Array<{ name: string; type: string; embedded?: true }> : [];
  } catch {
    return [];
  }
}

// `foreignKey:AuthorID;many2many:article_tags` → lower-cased keys.
function gormTagSettings(tag: string): Map<string, string> {
  const settings = new Map<string, string>();
  for (const part of tag.split(";")) {
    const colon = part.indexOf(":");
    const key = (colon === -1 ? part : part.slice(0, colon)).trim().toLowerCase();
    if (key) settings.set(key, colon === -1 ? "" : part.slice(colon + 1).trim());
  }
  return settings;
}

// gorm's default table name: snake case, the last word pluralized.
export function gormTableName(name: string): string {
  const snake = name
    .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1_$2")
    .replace(/([a-z\d])([A-Z])/gu, "$1_$2")
    .toLowerCase();
  const parts = snake.split("_");
  parts[parts.length - 1] = pluralize(parts[parts.length - 1]!);
  return parts.join("_");
}

const irregular = new Map([["person", "people"], ["man", "men"], ["woman", "women"], ["child", "children"], ["mouse", "mice"], ["goose", "geese"], ["tooth", "teeth"], ["foot", "feet"]]);
const uncountable = new Set(["equipment", "information", "rice", "money", "species", "series", "fish", "sheep", "deer", "news", "jeans", "police"]);

function pluralize(word: string): string {
  if (uncountable.has(word)) return word;
  const known = irregular.get(word);
  if (known) return known;
  if (/(?:s|x|z|ch|sh)$/u.test(word)) return `${word}es`;
  if (/[^aeiou]y$/u.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

// The selector calls a call's own chain makes (`db.Where(…).First` → 2).
function ownSteps(fn: SyntaxNode): number {
  let count = 0;
  for (let current: SyntaxNode | null = fn; current?.type === "selector_expression"; ) {
    count += 1;
    const operand: SyntaxNode | null = current.childForFieldName("operand");
    current = operand?.type === "call_expression" ? operand.childForFieldName("function") : null;
  }
  return count;
}

// Whether a call's result is only the receiver of another call in a chain
// (`db.Where(…)` in `db.Where(…).First(&x)`).
function isChained(call: SyntaxNode): boolean {
  const parent = call.parent;
  const operand = parent?.type === "selector_expression" ? parent.childForFieldName("operand") : null;
  return !!operand && same(operand, call) && parent?.parent?.type === "call_expression";
}

// Syntax nodes are new objects on every access: the same node is the same span.
function same(left: SyntaxNode, right: SyntaxNode): boolean {
  return left.startIndex === right.startIndex && left.endIndex === right.endIndex && left.type === right.type;
}

function assignmentOf(node: SyntaxNode, name: string): { type: string } | { value: SyntaxNode } | null | undefined {
  if (node.type === "var_spec") {
    const names = node.childrenForFieldName("name");
    const index = names.findIndex((id) => id.text === name);
    if (index === -1) return undefined;
    const type = node.childForFieldName("type")?.text;
    if (type) return { type };
    const values = node.childForFieldName("value")?.namedChildren ?? [];
    const value = values[index] ?? (values.length === 1 && index === 0 ? values[0] : undefined);
    return value ? { value } : null;
  }
  const names = node.childForFieldName("left")?.namedChildren ?? [];
  const index = names.findIndex((id) => id.type === "identifier" && id.text === name);
  if (index === -1) return undefined;
  const values = node.childForFieldName("right")?.namedChildren ?? [];
  const value = values.length === names.length ? values[index] : values.length === 1 && index === 0 ? values[0] : undefined;
  return value ? { value } : null;
}

// A declaration in a closure that does not contain the point is not seen.
function visibleFrom(declaration: SyntaxNode, at: SyntaxNode, scope: SyntaxNode): boolean {
  for (let node = declaration.parent; node && !same(node, scope); node = node.parent) {
    if (node.type === "func_literal" && !(node.startIndex <= at.startIndex && at.endIndex <= node.endIndex)) return false;
  }
  return true;
}

function isPackageLevel(spec: SyntaxNode): boolean {
  const declaration = spec.parent?.type === "var_declaration" ? spec.parent : spec.parent?.parent;
  return declaration?.parent?.type === "source_file";
}

function insideFunction(node: SyntaxNode): boolean {
  for (let current = node.parent; current; current = current.parent) if (FUNCTION_TYPES.has(current.type)) return true;
  return false;
}

// The type a value is written with: `T{}`, `&T{}`, `[]T{}`, `make([]T, n)`, `new(T)`.
function valueTypeText(value: SyntaxNode): string | undefined {
  if (value.type === "unary_expression" && value.childForFieldName("operator")?.text === "&") {
    const operand = value.childForFieldName("operand");
    return operand?.type === "composite_literal" ? valueTypeText(operand) : undefined;
  }
  if (value.type === "composite_literal") return value.childForFieldName("type")?.text;
  if (value.type === "call_expression") {
    const fn = value.childForFieldName("function")?.text;
    const first = value.childForFieldName("arguments")?.namedChildren[0];
    if ((fn === "make" || fn === "new") && first) return fn === "new" ? `*${first.text}` : first.text;
  }
  return undefined;
}

function stringConstants(root: SyntaxNode): Map<string, string> {
  const constants = new Map<string, string>();
  for (const spec of root.descendantsOfType("const_spec")) {
    const names = spec.childrenForFieldName("name");
    const values = spec.childForFieldName("value")?.namedChildren ?? [];
    names.forEach((name, index) => {
      const value = values[index];
      if (value?.type === "interpreted_string_literal" || value?.type === "raw_string_literal") constants.set(name.text, value.text.slice(1, -1));
    });
  }
  return constants;
}

function defaultPackageName(source: string): string {
  const parts = source.split("/");
  const last = parts[parts.length - 1]!;
  return /^v\d+$/u.test(last) && parts.length > 1 ? parts[parts.length - 2]! : last;
}


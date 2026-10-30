import type { GraphNode, GraphRelationship } from "../../../../core/graph/model.js";
import type { IGraphContributor } from "../../../../core/contracts/graph-contributor.js";
import { nearestPackageDirectory, resolvePrismaModel, tableId, type PrismaModelIndex } from "../prisma-schema.js";
import type { PendingRelation } from "../data-schemas.js";

type DataAccess = {
  modelName: string;
  library: string;
  operation: string;
  line: number;
  expression: string;
  // A model declared in a schema file (Prisma), instead of one named after
  // the call.
  modelId?: string;
};

type ModelHint = {
  modelName: string;
  library: string;
};

// ORM and query-builder methods by the operation they perform: Prisma
// (including `findUniqueOrThrow`, `groupBy`), Sequelize (`findAndCountAll`,
// `bulkCreate`), Knex and Drizzle, the TypeORM Repository / EntityManager API
// (`findOneBy`, `softDelete`, `increment`, …) and the Mongoose Model API
// (`findByIdAndUpdate`, `findOneAndDelete`, `countDocuments`, …). Only calls on
// a receiver known to be a model or repository are classified.
const operationByMethod = new Map<string, string>([
  ["aggregate", "aggregate"],
  ["average", "aggregate"],
  ["bulkCreate", "create"],
  ["clear", "delete"],
  ["count", "read"],
  ["countBy", "read"],
  ["countDocuments", "read"],
  ["create", "create"],
  ["createMany", "create"],
  ["decrement", "update"],
  ["delete", "delete"],
  ["deleteMany", "delete"],
  ["deleteOne", "delete"],
  ["destroy", "delete"],
  ["distinct", "read"],
  ["estimatedDocumentCount", "read"],
  ["exist", "read"],
  ["exists", "read"],
  ["existsBy", "read"],
  ["find", "read"],
  ["findAll", "read"],
  ["findAndCount", "read"],
  ["findAndCountAll", "read"],
  ["findAndCountBy", "read"],
  ["findBy", "read"],
  ["findById", "read"],
  ["findByIdAndDelete", "delete"],
  ["findByIdAndRemove", "delete"],
  ["findByIdAndUpdate", "update"],
  ["findByIds", "read"],
  ["findByPk", "read"],
  ["findFirst", "read"],
  ["findFirstOrThrow", "read"],
  ["findMany", "read"],
  ["findOne", "read"],
  ["findOneAndDelete", "delete"],
  ["findOneAndRemove", "delete"],
  ["findOneAndReplace", "update"],
  ["findOneAndUpdate", "update"],
  ["findOneBy", "read"],
  ["findOneByOrFail", "read"],
  ["findOneOrFail", "read"],
  ["findUnique", "read"],
  ["findUniqueOrThrow", "read"],
  ["groupBy", "aggregate"],
  ["increment", "update"],
  ["insert", "create"],
  ["insertMany", "create"],
  ["maximum", "aggregate"],
  ["minimum", "aggregate"],
  ["preload", "read"],
  ["recover", "update"],
  ["remove", "delete"],
  ["replaceOne", "update"],
  ["restore", "update"],
  ["save", "create"],
  ["select", "read"],
  ["softDelete", "delete"],
  ["softRemove", "delete"],
  ["sum", "aggregate"],
  ["transaction", "transaction"],
  ["update", "update"],
  ["updateMany", "update"],
  ["updateOne", "update"],
  ["upsert", "upsert"],
]);

// Operations that read or write a model's table.
const readOperations = new Set(["read", "aggregate"]);
const writeOperations = new Set(["create", "update", "delete", "upsert"]);

export function addDataAccessRelationships(
  graph: IGraphContributor,
  prismaModels: PrismaModelIndex = { schemas: [], packageDirectories: [] },
): void {
  const context = createDataAccessContext(graph.nodes, graph.relationships);
  const directAccesses: Array<{ from: string; to: string; dataAccess: DataAccess }> = [];
  const filePaths = new Set(graph.nodes.flatMap((node) => (
    node.label === "File" && typeof node.properties.relativePath === "string" ? [node.properties.relativePath] : []
  )));
  const declaredModels = new DeclaredModels(graph.nodes, prismaModels.packageDirectories);
  addDeclaredRelations(graph, declaredModels);

  for (const callNode of [...graph.nodes]) {
    if (callNode.label !== "Call") continue;

    const dataAccess = classifyDataAccessCall(callNode, context);
    if (!dataAccess) continue;

    const file = fileOfNodeId(callNode.id, filePaths);
    const declared = !file ? null : dataAccess.library === "prisma"
      ? resolvePrismaModel(prismaModels, file, dataAccess.modelName)
      : declaredModels.resolve(dataAccess.library, file, dataAccess.modelName);
    if (declared) dataAccess.modelId = declared;

    let modelId = dataAccess.modelId;
    if (!modelId) {
      const modelNode = createDataModelNode(dataAccess);
      graph.addNode(modelNode);
      modelId = modelNode.id;
      if (dataAccess.library === "knex") addKnexTable(graph, modelNode.id, dataAccess.modelName);
    }

    for (const sourceId of accessSourceIds(callNode.id, context)) {
      addDataAccessRelationship(graph, sourceId, modelId, dataAccess);
      directAccesses.push({ from: sourceId, to: modelId, dataAccess });
    }
  }

  propagateDataAccessThroughResolvedCalls(graph, context, directAccesses);
  addTableAccessRelationships(graph);
}

// Models declared in source (TypeORM entities, Mongoose schemas, Drizzle
// tables) by library and name. A name resolves to the declaration in the
// caller's package, else to the repository's only declaration of it.
class DeclaredModels {
  private readonly byKey = new Map<string, Array<{ id: string; packageDirectory: string | null }>>();

  constructor(nodes: readonly GraphNode[], private readonly packageDirectories: readonly string[]) {
    for (const node of nodes) {
      const { name, library, declaredIn } = node.properties;
      if (node.label !== "DataModel" || library === "prisma" || typeof name !== "string" || typeof library !== "string" || typeof declaredIn !== "string") continue;
      const key = `${library}\0${name}`;
      this.byKey.set(key, [...(this.byKey.get(key) ?? []), { id: node.id, packageDirectory: this.packageOf(declaredIn) }]);
    }
  }

  resolve(library: string, file: string, name: string): string | null {
    const candidates = this.byKey.get(`${library}\0${name}`) ?? [];
    const packageDirectory = this.packageOf(file);
    const local = candidates.filter((candidate) => candidate.packageDirectory === packageDirectory);
    const matches = local.length > 0 ? local : candidates;
    return matches.length === 1 ? matches[0]!.id : null;
  }

  private packageOf(file: string): string | null {
    const directory = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
    return nearestPackageDirectory(directory, this.packageDirectories);
  }
}

// RELATES_TO for the relations declarations name by class or variable
// (`pendingRelations`, set at parse time), then the property is dropped.
function addDeclaredRelations(graph: IGraphContributor, declaredModels: DeclaredModels): void {
  for (const node of graph.nodes) {
    const pending = node.properties.pendingRelations;
    if (node.label !== "DataModel" || pending === undefined) continue;
    delete node.properties.pendingRelations;
    if (typeof pending !== "string" || typeof node.properties.declaredIn !== "string") continue;
    let relations: PendingRelation[];
    try {
      relations = JSON.parse(pending) as PendingRelation[];
    } catch {
      continue;
    }
    for (const relation of relations) {
      const target = declaredModels.resolve(String(node.properties.library), node.properties.declaredIn, relation.target);
      if (!target) continue;
      graph.addRelationship({
        from: node.id,
        to: target,
        type: "RELATES_TO",
        properties: {
          field: relation.field,
          kind: relation.kind,
          fields: JSON.stringify(relation.fields),
          references: JSON.stringify(relation.references),
          relationName: relation.relationName,
          onDelete: relation.onDelete,
        },
      });
    }
  }
}

// Node ids start with their file's id (`file:<relativePath>:...`).
function fileOfNodeId(id: string, filePaths: ReadonlySet<string>): string | null {
  if (!id.startsWith("file:")) return null;
  for (let index = id.indexOf(":", 5); index !== -1; index = id.indexOf(":", index + 1)) {
    const candidate = id.slice(5, index);
    if (filePaths.has(candidate)) return candidate;
  }
  return null;
}

// `knex('users')` names the table itself.
function addKnexTable(graph: IGraphContributor, modelId: string, name: string): void {
  const id = tableId("knex", null, name);
  graph.addNode({
    id,
    label: "Table",
    properties: { name, kind: "table", library: "knex", schemaName: null, provider: null, declaredIn: null, line: null, columns: "[]" },
  });
  graph.addRelationship({ from: modelId, to: id, type: "MAPS_TO_TABLE", properties: {} });
}

// READS / WRITES from every data access (direct or propagated) whose model
// maps to a table.
function addTableAccessRelationships(graph: IGraphContributor): void {
  const tableByModel = new Map<string, string>();
  const modelNames = new Map<string, string>();
  for (const relationship of graph.relationships) {
    if (relationship.type === "MAPS_TO_TABLE") tableByModel.set(relationship.from, relationship.to);
  }
  if (tableByModel.size === 0) return;
  for (const node of graph.nodes) {
    if (node.label === "DataModel" && typeof node.properties.name === "string") modelNames.set(node.id, node.properties.name);
  }

  for (const relationship of [...graph.relationships]) {
    if (relationship.type !== "ACCESSES_DATA") continue;
    const table = tableByModel.get(relationship.to);
    const operation = String(relationship.properties.operation);
    const type = readOperations.has(operation) ? "READS" : writeOperations.has(operation) ? "WRITES" : null;
    if (!table || !type) continue;
    graph.addRelationship({
      from: relationship.from,
      to: table,
      type,
      properties: {
        operation,
        line: relationship.properties.line,
        expression: relationship.properties.expression,
        model: modelNames.get(relationship.to) ?? null,
      },
    });
  }
}

function createDataAccessContext(nodes: GraphNode[], relationships: GraphRelationship[]): {
  callerFunctionByCallId: Map<string, string>;
  moduleFileByCallId: Map<string, string>;
  routesByFunctionId: Map<string, string[]>;
  entrypointsByFunctionId: Map<string, string[]>;
  variableLibraryByName: Map<string, string>;
  importedLibraryByName: Map<string, string>;
  modelHintByVariableName: Map<string, ModelHint>;
  modelHintByFieldByClassId: Map<string, Map<string, ModelHint>>;
  classIdByMethodId: Map<string, string>;
  resolvedFunctionByCallId: Map<string, string>;
  sequelizeModelClasses: Set<string>;
} {
  const callerFunctionByCallId = new Map<string, string>();
  const moduleFileByCallId = new Map<string, string>();
  const routesByFunctionId = new Map<string, string[]>();
  const entrypointsByFunctionId = new Map<string, string[]>();
  const variableLibraryByName = new Map<string, string>();
  const importedLibraryByName = new Map<string, string>();
  const modelHintByVariableName = new Map<string, ModelHint>();
  const modelHintByFieldByClassId = new Map<string, Map<string, ModelHint>>();
  const classIdByMethodId = new Map<string, string>();
  const resolvedFunctionByCallId = new Map<string, string>();
  const nodesById = new Map(nodes.map((node) => [node.id, node]));

  for (const node of nodes) {
    if (node.label !== "Variable") continue;
    const name = node.properties.name;
    const stringValue = node.properties.stringValue;
    if (typeof name === "string" && typeof stringValue === "string") {
      variableLibraryByName.set(name, stringValue);
    }
  }

  for (const rel of relationships) {
    if (rel.type === "IMPORTS") {
      const importNode = nodesById.get(rel.to);
      if (importNode?.label === "Import") {
        addImportedLibraryHints(importedLibraryByName, importNode);
      }
    }
  }

  for (const rel of relationships) {
    if (rel.type === "CALLS") {
      callerFunctionByCallId.set(rel.to, rel.from);
    } else if (rel.type === "MODULE_CALLS") {
      moduleFileByCallId.set(rel.to, rel.from);
    } else if (rel.type === "ROUTE_HANDLED_BY") {
      routesByFunctionId.set(rel.to, [...(routesByFunctionId.get(rel.to) ?? []), rel.from]);
    } else if (rel.type === "ENTRYPOINT_HANDLED_BY") {
      entrypointsByFunctionId.set(rel.to, [...(entrypointsByFunctionId.get(rel.to) ?? []), rel.from]);
    } else if (rel.type === "DEFINES_METHOD") {
      classIdByMethodId.set(rel.to, rel.from);
    } else if (rel.type === "CALL_RESOLVES_TO") {
      resolvedFunctionByCallId.set(rel.from, rel.to);
    } else if (rel.type === "INITIALIZED_BY") {
      const variable = nodesById.get(rel.from);
      const initializer = nodesById.get(rel.to);
      const variableName = variable?.properties.name;
      const library = inferVariableLibrary(initializer, importedLibraryByName);
      if (typeof variableName === "string" && library) {
        variableLibraryByName.set(variableName, library);
        modelHintByVariableName.set(variableName, {
          library,
          modelName: inferModelNameFromVariable(variableName, library),
        });
      }
    }
  }

  const prismaClientClasses = prismaClientSubclasses(nodes);
  const sequelizeModelClasses = sequelizeModelSubclasses(nodes, relationships, nodesById);
  for (const rel of relationships) {
    if (rel.type !== "DEFINES_FIELD") continue;

    const field = nodesById.get(rel.to);
    if (field?.label !== "Field") continue;

    const fieldName = field.properties.name;
    const typeName = field.properties.typeName;
    if (typeof fieldName !== "string" || typeof typeName !== "string") continue;

    const hint = inferModelHintFromField(fieldName, typeName, prismaClientClasses);
    if (!hint) continue;

    let hints = modelHintByFieldByClassId.get(rel.from);
    if (!hints) {
      hints = new Map();
      modelHintByFieldByClassId.set(rel.from, hints);
    }
    hints.set(fieldName, hint);
  }

  return {
    callerFunctionByCallId,
    moduleFileByCallId,
    routesByFunctionId,
    entrypointsByFunctionId,
    variableLibraryByName,
    importedLibraryByName,
    modelHintByVariableName,
    modelHintByFieldByClassId,
    classIdByMethodId,
    resolvedFunctionByCallId,
    sequelizeModelClasses,
  };
}

function accessSourceIds(callId: string, context: ReturnType<typeof createDataAccessContext>): string[] {
  const functionId = context.callerFunctionByCallId.get(callId);
  if (functionId) {
    return [
      functionId,
      ...(context.routesByFunctionId.get(functionId) ?? []),
      ...(context.entrypointsByFunctionId.get(functionId) ?? []),
    ];
  }

  const fileId = context.moduleFileByCallId.get(callId);
  return fileId ? [fileId] : [];
}

function classifyDataAccessCall(
  callNode: GraphNode,
  context: ReturnType<typeof createDataAccessContext>,
): DataAccess | null {
  const expression = callNode.properties.expression;
  const callee = callNode.properties.callee;
  const receiver = callNode.properties.receiver;
  if (typeof expression !== "string" || typeof callee !== "string") {
    return null;
  }

  // `from` only counts in Drizzle's db.select().from(table).
  const operation = operationByMethod.get(callee) ?? (callee === "from" ? "read" : undefined);
  if (!operation) return null;

  const knexAccess = callee === "from" ? null : classifyKnexAccess(expression, operation, callNode);
  if (knexAccess) return knexAccess;

  if (typeof receiver !== "string") {
    return null;
  }
  if (callee === "from" && context.variableLibraryByName.get(receiver.split(".")[0] ?? receiver) !== "drizzle") {
    return null;
  }

  const receiverParts = receiver.split(".");
  const root = receiverParts[0] ?? receiver;
  const line = Number(callNode.properties.line);
  const safeLine = Number.isFinite(line) ? line : 0;

  const fieldHint = resolveFieldModelHint(callNode, receiverParts, context);
  if (fieldHint) {
    return {
      modelName: fieldHint.modelName,
      library: fieldHint.library,
      operation,
      line: safeLine,
      expression,
    };
  }

  // `Customer.findAll()` on a class-based model (`class Customer extends Model`).
  if (receiverParts.length === 1 && context.sequelizeModelClasses.has(root)) {
    return {
      modelName: root,
      library: "sequelize",
      operation,
      line: safeLine,
      expression,
    };
  }

  const variableLibrary = context.variableLibraryByName.get(root);

  if ((root === "prisma" || variableLibrary === "prisma") && receiverParts.length >= 2) {
    return {
      modelName: receiverParts[1]!,
      library: "prisma",
      operation,
      line: safeLine,
      expression,
    };
  }

  if (receiverParts.length >= 2 && receiverParts[1] === "manager") {
    return {
      modelName: receiverParts[0]!,
      library: "typeorm",
      operation,
      line: safeLine,
      expression,
    };
  }

  if (root.endsWith("Repository") || root.endsWith("Repo")) {
    return {
      modelName: stripRepositorySuffix(root),
      library: "typeorm",
      operation,
      line: safeLine,
      expression,
    };
  }

  if (root.endsWith("Model")) {
    return {
      modelName: root.slice(0, -"Model".length) || root,
      library: "mongoose",
      operation,
      line: safeLine,
      expression,
    };
  }

  if (variableLibrary === "drizzle") {
    const drizzleModel = drizzleModelName(callee, receiverParts, expression, callNode);
    return drizzleModel
      ? { modelName: drizzleModel.model, library: "drizzle", operation: drizzleModel.operation, line: safeLine, expression }
      : null;
  }

  if (variableLibrary && variableLibrary !== "prisma") {
    const variableHint = context.modelHintByVariableName.get(root);
    return {
      modelName: variableHint?.modelName ?? root,
      library: variableLibrary,
      operation,
      line: safeLine,
      expression,
    };
  }

  return null;
}

function propagateDataAccessThroughResolvedCalls(
  graph: IGraphContributor,
  context: ReturnType<typeof createDataAccessContext>,
  directAccesses: Array<{ from: string; to: string; dataAccess: DataAccess }>,
): void {
  const dataAccessesByFunctionId = new Map<string, Array<{ to: string; dataAccess: DataAccess }>>();

  for (const access of directAccesses) {
    if (!access.from.includes(":function:")) continue;
    dataAccessesByFunctionId.set(access.from, [...(dataAccessesByFunctionId.get(access.from) ?? []), access]);
  }

  let changed = true;
  while (changed) {
    changed = false;

    for (const [callId, targetFunctionId] of context.resolvedFunctionByCallId) {
      const callerFunctionId = context.callerFunctionByCallId.get(callId);
      if (!callerFunctionId || callerFunctionId === targetFunctionId) continue;

      const targetAccesses = dataAccessesByFunctionId.get(targetFunctionId);
      if (!targetAccesses || targetAccesses.length === 0) continue;

      for (const access of targetAccesses) {
        if (hasDataAccess(dataAccessesByFunctionId.get(callerFunctionId), access.to, access.dataAccess)) {
          continue;
        }

        addDataAccessRelationship(graph, callerFunctionId, access.to, access.dataAccess);
        dataAccessesByFunctionId.set(callerFunctionId, [
          ...(dataAccessesByFunctionId.get(callerFunctionId) ?? []),
          access,
        ]);
        for (const sourceId of [
          ...(context.routesByFunctionId.get(callerFunctionId) ?? []),
          ...(context.entrypointsByFunctionId.get(callerFunctionId) ?? []),
        ]) {
          addDataAccessRelationship(graph, sourceId, access.to, access.dataAccess);
        }
        changed = true;
      }
    }
  }
}

function addDataAccessRelationship(
  graph: IGraphContributor,
  from: string,
  to: string,
  dataAccess: DataAccess,
): void {
  graph.addRelationship({
    from,
    to,
    type: "ACCESSES_DATA",
    properties: {
      operation: dataAccess.operation,
      library: dataAccess.library,
      line: dataAccess.line,
      expression: dataAccess.expression,
    },
  });
}

function hasDataAccess(
  accesses: Array<{ to: string; dataAccess: DataAccess }> | undefined,
  to: string,
  dataAccess: DataAccess,
): boolean {
  return accesses?.some((access) => (
    access.to === to
    && access.dataAccess.operation === dataAccess.operation
    && access.dataAccess.library === dataAccess.library
    && access.dataAccess.expression === dataAccess.expression
    && access.dataAccess.line === dataAccess.line
  )) ?? false;
}

function resolveFieldModelHint(
  callNode: GraphNode,
  receiverParts: string[],
  context: ReturnType<typeof createDataAccessContext>,
): ModelHint | null {
  if (receiverParts[0] !== "this") {
    return null;
  }

  const fieldName = receiverParts[1];
  if (!fieldName) {
    return null;
  }

  const callerFunctionId = context.callerFunctionByCallId.get(callNode.id);
  if (!callerFunctionId) {
    return null;
  }

  const callerClassId = context.classIdByMethodId.get(callerFunctionId);
  if (!callerClassId) {
    return null;
  }

  const hint = context.modelHintByFieldByClassId.get(callerClassId)?.get(fieldName);
  if (!hint) {
    return null;
  }

  if (hint.library === "prisma" && receiverParts.length >= 3) {
    return {
      library: "prisma",
      modelName: receiverParts[2]!,
    };
  }

  return hint;
}

function classifyKnexAccess(
  expression: string,
  operation: string,
  callNode: GraphNode,
): DataAccess | null {
  const match = expression.match(/\b(?:knex|createKnex)\(\s*["'`]([^"'`]+)["'`]\s*\)/u);
  if (!match?.[1]) {
    return null;
  }

  const line = Number(callNode.properties.line);
  return {
    modelName: match[1],
    library: "knex",
    operation,
    line: Number.isFinite(line) ? line : 0,
    expression,
  };
}

function createDataModelNode(dataAccess: DataAccess): GraphNode {
  return {
    id: `datamodel:${dataAccess.library}:${dataAccess.modelName}`,
    label: "DataModel",
    properties: {
      name: dataAccess.modelName,
      library: dataAccess.library,
    },
  };
}

// Drizzle queries name the table variable: db.select().from(users),
// db.insert(users), db.update(users), db.delete(users),
// db.query.users.findMany().
function drizzleModelName(
  callee: string,
  receiverParts: string[],
  expression: string,
  callNode: GraphNode,
): { model: string; operation: string } | null {
  if (receiverParts[1] === "query" && receiverParts[2]) {
    const operation = operationByMethod.get(callee);
    return operation === "read" ? { model: receiverParts[2], operation } : null;
  }
  const first = firstIdentifierArg(callNode);
  if (!first) return null;
  if (callee === "from" && /\.select(?:Distinct(?:On)?)?\(/u.test(expression)) return { model: first, operation: "read" };
  if (callee === "insert") return { model: first, operation: "create" };
  if (callee === "update") return { model: first, operation: "update" };
  if (callee === "delete") return { model: first, operation: "delete" };
  return null;
}

function firstIdentifierArg(callNode: GraphNode): string | null {
  try {
    const args = JSON.parse(String(callNode.properties.args ?? "[]")) as unknown[];
    const first = args[0];
    return typeof first === "string" && /^[A-Za-z_$][\w$]*$/u.test(first) ? first : null;
  } catch {
    return null;
  }
}

function stripRepositorySuffix(value: string): string {
  return value.replace(/Repository$|Repo$/u, "") || value;
}

function inferVariableLibrary(
  initializer: GraphNode | undefined,
  importedLibraryByName = new Map<string, string>(),
): string | null {
  if (!initializer || initializer.label !== "Call") return null;

  const callee = initializer.properties.callee;
  const receiver = initializer.properties.receiver;
  const expression = initializer.properties.expression;
  const text = [callee, receiver, expression].filter((value): value is string => typeof value === "string").join(".");
  const importedLibrary = typeof callee === "string" ? importedLibraryByName.get(callee) : null;
  if (importedLibrary) return importedLibrary;

  if (/\bPrismaClient\b/u.test(text)) return "prisma";
  if (/\bmongoose\b/u.test(text) || /\b(createModel|model)\b/u.test(text)) return "mongoose";
  if (/\bsequelize\b/ui.test(text) || /\bcreateSequelizeModel\b/u.test(text)) return "sequelize";
  if (/\b(knex|createKnex)\b/u.test(text)) return "knex";
  if (/\b(createRepository|getRepository)\b/u.test(text)) return "typeorm";

  return null;
}

function addImportedLibraryHints(importedLibraryByName: Map<string, string>, importNode: GraphNode): void {
  const source = importNode.properties.source;
  const bindings = importNode.properties.bindings;
  if (typeof source !== "string" || typeof bindings !== "string") {
    return;
  }

  let parsedBindings: Array<{ imported: string; local: string; kind: string }>;
  try {
    parsedBindings = JSON.parse(bindings) as Array<{ imported: string; local: string; kind: string }>;
  } catch {
    return;
  }

  for (const binding of parsedBindings) {
    const library = inferLibraryFromImport(source, binding.imported, binding.kind);
    if (library) {
      importedLibraryByName.set(binding.local, library);
    }
  }
}

function inferLibraryFromImport(source: string, imported: string, kind: string): string | null {
  if (source === "@prisma/client" && (imported === "PrismaClient" || kind === "namespace")) {
    return "prisma";
  }
  if (source === "mongoose" && ["mongoose", "model", "Model", "*"].includes(imported)) {
    return "mongoose";
  }
  if (source === "sequelize" || source === "sequelize-typescript") {
    return "sequelize";
  }
  if (source === "knex" && ["knex", "default", "*"].includes(imported)) {
    return "knex";
  }
  if (source === "typeorm" && ["Repository", "getRepository", "createRepository", "DataSource"].includes(imported)) {
    return "typeorm";
  }
  if (source.startsWith("drizzle-orm") && imported === "drizzle") {
    return "drizzle";
  }
  return null;
}

// Names of class-based Sequelize models: classes that extend the `Model` their
// file imports from sequelize or sequelize-typescript, directly or through
// other model classes (`class Customer extends Model` + `Customer.init(…)`,
// or a `@Table` class).
function sequelizeModelSubclasses(
  nodes: readonly GraphNode[],
  relationships: readonly GraphRelationship[],
  nodesById: ReadonlyMap<string, GraphNode>,
): Set<string> {
  const modelBasesByFile = new Map<string, Set<string>>();
  const fileByClassId = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.type === "DEFINES_CLASS") {
      fileByClassId.set(rel.to, rel.from);
      continue;
    }
    if (rel.type !== "IMPORTS") continue;
    const importNode = nodesById.get(rel.to);
    const source = importNode?.properties.source;
    const bindings = importNode?.properties.bindings;
    if (source !== "sequelize" && source !== "sequelize-typescript") continue;
    if (typeof bindings !== "string") continue;
    try {
      for (const binding of JSON.parse(bindings) as Array<{ imported: string; local: string }>) {
        if (binding.imported !== "Model") continue;
        const bases = modelBasesByFile.get(rel.from) ?? new Set<string>();
        bases.add(binding.local);
        modelBasesByFile.set(rel.from, bases);
      }
    } catch {
      // Unreadable bindings: no model base from this import.
    }
  }

  const parentsByClass = new Map<string, { parents: string[]; bases: ReadonlySet<string> }>();
  for (const node of nodes) {
    if (node.label !== "Class" || typeof node.properties.name !== "string" || typeof node.properties.extendsNames !== "string") continue;
    try {
      const parents = JSON.parse(node.properties.extendsNames) as unknown;
      if (!Array.isArray(parents)) continue;
      const fileId = fileByClassId.get(node.id);
      const bases = (fileId ? modelBasesByFile.get(fileId) : undefined) ?? new Set<string>();
      parentsByClass.set(node.properties.name, { parents: parents.map(String), bases });
    } catch {
      // Not a name list: no parents.
    }
  }
  const models = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, { parents, bases }] of parentsByClass) {
      if (models.has(name)) continue;
      if (parents.some((parent) => bases.has(parent) || models.has(parent))) {
        models.add(name);
        changed = true;
      }
    }
  }
  return models;
}

// Names of classes that extend PrismaClient, directly or through other
// classes (`class PrismaService extends PrismaClient`, the NestJS pattern).
function prismaClientSubclasses(nodes: readonly GraphNode[]): Set<string> {
  const parentsByClass = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.label !== "Class" || typeof node.properties.name !== "string" || typeof node.properties.extendsNames !== "string") continue;
    try {
      const parents = JSON.parse(node.properties.extendsNames) as unknown;
      if (Array.isArray(parents)) parentsByClass.set(node.properties.name, parents.map(String));
    } catch {
      // Not a name list: no parents.
    }
  }
  const subclasses = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, parents] of parentsByClass) {
      if (subclasses.has(name)) continue;
      if (parents.some((parent) => parent === "PrismaClient" || subclasses.has(parent))) {
        subclasses.add(name);
        changed = true;
      }
    }
  }
  return subclasses;
}

function inferModelHintFromField(fieldName: string, typeName: string, prismaClientClasses: ReadonlySet<string>): ModelHint | null {
  const normalizedType = normalizeTypeName(typeName);
  if (normalizedType === "PrismaClient" || prismaClientClasses.has(normalizedType)) {
    return { library: "prisma", modelName: fieldName };
  }

  // Repository<User>, and TypeORM's MongoRepository<User> / TreeRepository<User>.
  const repositoryModel = extractGenericType(typeName, "(?:Mongo|Tree)?Repository")
    ?? (normalizedType.endsWith("Repository") || normalizedType.endsWith("Repo")
      ? stripRepositorySuffix(normalizedType)
      : null);
  if (repositoryModel) {
    return {
      library: "typeorm",
      modelName: repositoryModel || inferModelNameFromVariable(fieldName, "typeorm"),
    };
  }

  const mongooseModel = extractGenericType(typeName, "Model")
    ?? (normalizedType.endsWith("Model") ? normalizedType.slice(0, -"Model".length) : null);
  if (mongooseModel) {
    return {
      library: "mongoose",
      modelName: mongooseModel || inferModelNameFromVariable(fieldName, "mongoose"),
    };
  }

  if (/SequelizeModel$/u.test(normalizedType)) {
    return {
      library: "sequelize",
      modelName: normalizedType.replace(/SequelizeModel$/u, "") || inferModelNameFromVariable(fieldName, "sequelize"),
    };
  }

  return null;
}

function inferModelNameFromVariable(variableName: string, library: string): string {
  if (library === "typeorm") {
    return stripRepositorySuffix(variableName);
  }
  if (library === "mongoose" && variableName.endsWith("Model")) {
    return variableName.slice(0, -"Model".length) || variableName;
  }
  return variableName;
}

function normalizeTypeName(typeName: string): string {
  return typeName.replace(/<[\s\S]*>$/u, "").split(".").at(-1)?.trim() ?? typeName.trim();
}

function extractGenericType(typeName: string, genericName: string): string | null {
  const match = typeName.match(new RegExp(`\\b${genericName}\\s*<\\s*([A-Za-z_$][\\w$]*)`, "u"));
  return match?.[1] ?? null;
}

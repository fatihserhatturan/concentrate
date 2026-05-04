import type { GraphNode, GraphRelationship } from "../../../../core/graph/model.js";
import { GraphBuilder } from "../../../../core/graph/builder.js";

type DataAccess = {
  modelName: string;
  library: string;
  operation: string;
  line: number;
  expression: string;
};

type ModelHint = {
  modelName: string;
  library: string;
};

const operationByMethod = new Map<string, string>([
  ["aggregate", "aggregate"],
  ["count", "read"],
  ["create", "create"],
  ["createMany", "create"],
  ["delete", "delete"],
  ["deleteMany", "delete"],
  ["destroy", "delete"],
  ["find", "read"],
  ["findAll", "read"],
  ["findById", "read"],
  ["findByPk", "read"],
  ["findFirst", "read"],
  ["findMany", "read"],
  ["findOne", "read"],
  ["findUnique", "read"],
  ["insert", "create"],
  ["insertMany", "create"],
  ["remove", "delete"],
  ["save", "create"],
  ["select", "read"],
  ["transaction", "transaction"],
  ["update", "update"],
  ["updateMany", "update"],
  ["upsert", "upsert"],
]);

export function addDataAccessRelationships(graph: GraphBuilder): void {
  const context = createDataAccessContext(graph.nodes, graph.relationships);
  const directAccesses: Array<{ from: string; to: string; dataAccess: DataAccess }> = [];

  for (const callNode of graph.nodes) {
    if (callNode.label !== "Call") continue;

    const dataAccess = classifyDataAccessCall(callNode, context);
    if (!dataAccess) continue;

    const modelNode = createDataModelNode(dataAccess);
    graph.addNode(modelNode);

    for (const sourceId of accessSourceIds(callNode.id, context)) {
      addDataAccessRelationship(graph, sourceId, modelNode.id, dataAccess);
      directAccesses.push({ from: sourceId, to: modelNode.id, dataAccess });
    }
  }

  propagateDataAccessThroughResolvedCalls(graph, context, directAccesses);
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

  for (const rel of relationships) {
    if (rel.type !== "DEFINES_FIELD") continue;

    const field = nodesById.get(rel.to);
    if (field?.label !== "Field") continue;

    const fieldName = field.properties.name;
    const typeName = field.properties.typeName;
    if (typeof fieldName !== "string" || typeof typeName !== "string") continue;

    const hint = inferModelHintFromField(fieldName, typeName);
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

  const operation = operationByMethod.get(callee);
  if (!operation) return null;

  const knexAccess = classifyKnexAccess(expression, operation, callNode);
  if (knexAccess) return knexAccess;

  if (typeof receiver !== "string") {
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
  graph: GraphBuilder,
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
  graph: GraphBuilder,
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
  return null;
}

function inferModelHintFromField(fieldName: string, typeName: string): ModelHint | null {
  const normalizedType = normalizeTypeName(typeName);
  if (normalizedType === "PrismaClient") {
    return { library: "prisma", modelName: fieldName };
  }

  const repositoryModel = extractGenericType(typeName, "Repository")
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

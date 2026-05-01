import type { GraphNode, GraphRelationship } from "../../graph/model.js";
import { GraphBuilder } from "../../graph/builder.js";

type DataAccess = {
  modelName: string;
  library: string;
  operation: string;
  line: number;
  expression: string;
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
  ["transaction", "transaction"],
  ["update", "update"],
  ["updateMany", "update"],
  ["upsert", "upsert"],
]);

export function addDataAccessRelationships(graph: GraphBuilder): void {
  const context = createDataAccessContext(graph.nodes, graph.relationships);

  for (const callNode of graph.nodes) {
    if (callNode.label !== "Call") continue;

    const dataAccess = classifyDataAccessCall(callNode, context.variableLibraryByName);
    if (!dataAccess) continue;

    const modelNode = createDataModelNode(dataAccess);
    graph.addNode(modelNode);

    for (const sourceId of accessSourceIds(callNode.id, context)) {
      graph.addRelationship({
        from: sourceId,
        to: modelNode.id,
        type: "ACCESSES_DATA",
        properties: {
          operation: dataAccess.operation,
          library: dataAccess.library,
          line: dataAccess.line,
          expression: dataAccess.expression,
        },
      });
    }
  }
}

function createDataAccessContext(nodes: GraphNode[], relationships: GraphRelationship[]): {
  callerFunctionByCallId: Map<string, string>;
  moduleFileByCallId: Map<string, string>;
  routesByFunctionId: Map<string, string[]>;
  entrypointsByFunctionId: Map<string, string[]>;
  variableLibraryByName: Map<string, string>;
} {
  const callerFunctionByCallId = new Map<string, string>();
  const moduleFileByCallId = new Map<string, string>();
  const routesByFunctionId = new Map<string, string[]>();
  const entrypointsByFunctionId = new Map<string, string[]>();
  const variableLibraryByName = new Map<string, string>();
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
    if (rel.type === "CALLS") {
      callerFunctionByCallId.set(rel.to, rel.from);
    } else if (rel.type === "MODULE_CALLS") {
      moduleFileByCallId.set(rel.to, rel.from);
    } else if (rel.type === "ROUTE_HANDLED_BY") {
      routesByFunctionId.set(rel.to, [...(routesByFunctionId.get(rel.to) ?? []), rel.from]);
    } else if (rel.type === "ENTRYPOINT_HANDLED_BY") {
      entrypointsByFunctionId.set(rel.to, [...(entrypointsByFunctionId.get(rel.to) ?? []), rel.from]);
    } else if (rel.type === "INITIALIZED_BY") {
      const variable = nodesById.get(rel.from);
      const initializer = nodesById.get(rel.to);
      const variableName = variable?.properties.name;
      const library = inferVariableLibrary(initializer);
      if (typeof variableName === "string" && library) {
        variableLibraryByName.set(variableName, library);
      }
    }
  }

  return {
    callerFunctionByCallId,
    moduleFileByCallId,
    routesByFunctionId,
    entrypointsByFunctionId,
    variableLibraryByName,
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
  variableLibraryByName: Map<string, string>,
): DataAccess | null {
  const expression = callNode.properties.expression;
  const callee = callNode.properties.callee;
  const receiver = callNode.properties.receiver;
  if (typeof expression !== "string" || typeof callee !== "string" || typeof receiver !== "string") {
    return null;
  }

  const operation = operationByMethod.get(callee);
  if (!operation) return null;

  const receiverParts = receiver.split(".");
  const root = receiverParts[0] ?? receiver;
  const line = Number(callNode.properties.line);
  const safeLine = Number.isFinite(line) ? line : 0;

  const variableLibrary = variableLibraryByName.get(root);

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
    return {
      modelName: root,
      library: variableLibrary,
      operation,
      line: safeLine,
      expression,
    };
  }

  return null;
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

function inferVariableLibrary(initializer: GraphNode | undefined): string | null {
  if (!initializer || initializer.label !== "Call") return null;

  const callee = initializer.properties.callee;
  const receiver = initializer.properties.receiver;
  const expression = initializer.properties.expression;
  const text = [callee, receiver, expression].filter((value): value is string => typeof value === "string").join(".");

  if (/\bPrismaClient\b/u.test(text)) return "prisma";
  if (/\bmongoose\b/u.test(text) || /\bcreateModel\b/u.test(text)) return "mongoose";
  if (/\bsequelize\b/ui.test(text) || /\bcreateSequelizeModel\b/u.test(text)) return "sequelize";
  if (/\b(knex|createKnex)\b/u.test(text)) return "knex";
  if (/\b(createRepository|getRepository)\b/u.test(text)) return "typeorm";

  return null;
}

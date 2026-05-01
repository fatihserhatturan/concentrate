import { GraphBuilder } from "../../graph/builder.js";
import type { GraphNode, GraphRelationship } from "../../graph/model.js";
import {
  createResolutionRelationshipIndex,
  indexImportNodesByFile,
  indexNodesByFileAndName,
} from "./indexes.js";

export function addInstanceMethodResolutionRelationships(graph: GraphBuilder): void {
  const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
  const classesByFileAndName = indexNodesByFileAndName(graph.nodes, relationshipIndex.fileByClassId, "Class");
  const methodsByClassAndName = indexMethodsByClassAndName(graph.nodes, graph.relationships);
  const importsByFile = indexImportNodesByFile(graph.nodes, relationshipIndex.fileByImportId);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const fileIdByVariableId = indexFileIdByVariableId(graph.relationships);
  const classIdByVariableId = new Map<string, string>();

  for (const rel of graph.relationships) {
    if (rel.type !== "INITIALIZED_BY") continue;

    const variable = nodeById.get(rel.from);
    const call = nodeById.get(rel.to);
    if (variable?.label !== "Variable" || call?.label !== "Call") continue;

    const fileId = fileIdByVariableId.get(variable.id);
    const expression = call.properties.expression;
    if (!fileId || typeof expression !== "string" || !expression.startsWith("new ")) continue;

    const className = expression.slice("new ".length).split(".").at(-1)?.trim();
    if (!className) continue;

    const classId = resolveClassName(
      className,
      fileId,
      classesByFileAndName,
      importsByFile,
      relationshipIndex.resolvedFileByImportId,
    );
    if (classId) {
      classIdByVariableId.set(variable.id, classId);
    }
  }

  const classIdByVariableNameByFile = indexClassIdsByVariableNameByFile(
    graph.nodes,
    classIdByVariableId,
    fileIdByVariableId,
  );

  for (const call of graph.nodes) {
    if (call.label !== "Call") continue;

    const receiver = call.properties.receiver;
    const callee = call.properties.callee;
    if (typeof receiver !== "string" || typeof callee !== "string" || receiver.includes(".")) continue;

    const callerFunctionId = relationshipIndex.callerFunctionByCallId.get(call.id);
    if (!callerFunctionId) continue;

    const callerFileId = relationshipIndex.fileByFunctionId.get(callerFunctionId);
    if (!callerFileId) continue;

    const classId = classIdByVariableNameByFile.get(callerFileId)?.get(receiver);
    if (!classId) continue;

    const methodId = methodsByClassAndName.get(classId)?.get(callee)?.[0];
    if (!methodId) continue;

    graph.addRelationship({
      from: call.id,
      to: methodId,
      type: "CALL_RESOLVES_TO",
      properties: {},
    });
  }
}

function indexFileIdByVariableId(relationships: GraphRelationship[]): Map<string, string> {
  const fileIds = new Map<string, string>();
  for (const rel of relationships) {
    if (rel.type === "DEFINES_VARIABLE") {
      fileIds.set(rel.to, rel.from);
    }
  }
  return fileIds;
}

function indexClassIdsByVariableNameByFile(
  nodes: GraphNode[],
  classIdByVariableId: Map<string, string>,
  fileIdByVariableId: Map<string, string>,
): Map<string, Map<string, string>> {
  const result = new Map<string, Map<string, string>>();

  for (const node of nodes) {
    if (node.label !== "Variable") continue;

    const classId = classIdByVariableId.get(node.id);
    const fileId = fileIdByVariableId.get(node.id);
    const name = node.properties.name;
    if (!classId || !fileId || typeof name !== "string") continue;

    let variables = result.get(fileId);
    if (!variables) {
      variables = new Map();
      result.set(fileId, variables);
    }
    variables.set(name, classId);
  }

  return result;
}

function indexMethodsByClassAndName(
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): Map<string, Map<string, string[]>> {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const methods = new Map<string, Map<string, string[]>>();

  for (const rel of relationships) {
    if (rel.type !== "DEFINES_METHOD") continue;

    const method = nodeById.get(rel.to);
    const name = method?.properties.name;
    if (method?.label !== "Function" || typeof name !== "string") continue;

    let byName = methods.get(rel.from);
    if (!byName) {
      byName = new Map();
      methods.set(rel.from, byName);
    }
    byName.set(name, [...(byName.get(name) ?? []), method.id]);
  }

  return methods;
}

function resolveClassName(
  className: string,
  fileId: string,
  classesByFileAndName: Map<string, Map<string, string[]>>,
  importsByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  const sameFile = classesByFileAndName.get(fileId)?.get(className)?.[0];
  if (sameFile) return sameFile;

  for (const importNode of importsByFile.get(fileId) ?? []) {
    const targetFileId = resolvedFileByImportId.get(importNode.id);
    if (!targetFileId) continue;

    const imported = classesByFileAndName.get(targetFileId)?.get(className)?.[0];
    if (imported) return imported;
  }

  return null;
}

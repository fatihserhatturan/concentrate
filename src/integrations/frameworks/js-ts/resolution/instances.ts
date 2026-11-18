import type { IGraphContributor } from "../../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../../core/graph/model.js";
import { resolveImportedFreeCall } from "../../../../core/scan/resolution/call-targets.js";
import {
  createResolutionRelationshipIndex,
  indexImportNodesByFile,
  indexNodesByFileAndName,
} from "../../../../core/scan/resolution/indexes.js";

// `x.method()` where x is a module-level variable initialized with `new C()`:
// in the calling file, or imported from the file that declares it (named
// imports, through re-exports too). The method is looked up on C and then
// its base classes. A parameter of the calling function with the same name
// hides the variable.
export function addInstanceMethodResolutionRelationships(graph: IGraphContributor): void {
  // A resolved call needs a variable initialized by `new C()` with a scanned class.
  if (graph.relationshipsOfType("INITIALIZED_BY").length === 0 || graph.nodesWithLabel("Class").length === 0) return;

  const relationshipIndex = createResolutionRelationshipIndex(graph);
  const classesByFileAndName = indexNodesByFileAndName(graph.nodesWithLabel("Class"), relationshipIndex.fileByClassId, "Class");
  const methodsByClassAndName = indexMethodsByClassAndName(graph);
  const baseClassesByClass = indexBaseClasses(graph);
  const importsByFile = indexImportNodesByFile(graph.nodesWithLabel("Import"), relationshipIndex.fileByImportId);
  const fileIdByVariableId = indexFileIdByVariableId(graph);
  const classIdByVariableId = new Map<string, string>();

  for (const rel of graph.relationshipsOfType("INITIALIZED_BY")) {
    const variable = graph.node(rel.from);
    const call = graph.node(rel.to);
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
    graph,
    classIdByVariableId,
    fileIdByVariableId,
  );

  for (const call of graph.nodesWithLabel("Call")) {

    const receiver = call.properties.receiver;
    const callee = call.properties.callee;
    if (typeof receiver !== "string" || typeof callee !== "string" || receiver.includes(".")) continue;

    const callerFunctionId = relationshipIndex.callerFunctionByCallId.get(call.id);
    if (!callerFunctionId) continue;

    const callerFileId = relationshipIndex.fileByFunctionId.get(callerFunctionId);
    if (!callerFileId) continue;

    if (parameterNames(graph.node(callerFunctionId)?.properties.parameters).has(receiver)) continue;

    const classId = classIdByVariableNameByFile.get(callerFileId)?.get(receiver)?.[0]
      ?? resolveImportedFreeCall(receiver, callerFileId, classIdByVariableNameByFile, importsByFile, relationshipIndex.resolvedFileByImportId);
    if (!classId) continue;

    const methodId = findMethod(classId, callee, methodsByClassAndName, baseClassesByClass, new Set());
    if (!methodId) continue;

    graph.addRelationship({
      from: call.id,
      to: methodId,
      type: "CALL_RESOLVES_TO",
      properties: {},
    });
  }
}

function indexFileIdByVariableId(graph: IGraphContributor): Map<string, string> {
  const fileIds = new Map<string, string>();
  for (const rel of graph.relationshipsOfType("DEFINES_VARIABLE")) {
    fileIds.set(rel.to, rel.from);
  }
  return fileIds;
}

function indexClassIdsByVariableNameByFile(
  graph: IGraphContributor,
  classIdByVariableId: Map<string, string>,
  fileIdByVariableId: Map<string, string>,
): Map<string, Map<string, string[]>> {
  const result = new Map<string, Map<string, string[]>>();

  for (const node of graph.nodesWithLabel("Variable")) {
    const classId = classIdByVariableId.get(node.id);
    const fileId = fileIdByVariableId.get(node.id);
    const name = node.properties.name;
    if (!classId || !fileId || typeof name !== "string") continue;

    let variables = result.get(fileId);
    if (!variables) {
      variables = new Map();
      result.set(fileId, variables);
    }
    variables.set(name, [classId]);
  }

  return result;
}

function indexMethodsByClassAndName(graph: IGraphContributor): Map<string, Map<string, string[]>> {
  const methods = new Map<string, Map<string, string[]>>();

  for (const rel of graph.relationshipsOfType("DEFINES_METHOD")) {
    const method = graph.node(rel.to);
    const name = method?.properties.name;
    if (method?.label !== "Function" || typeof name !== "string") continue;

    let byName = methods.get(rel.from);
    if (!byName) {
      byName = new Map();
      methods.set(rel.from, byName);
    }
    const ids = byName.get(name);
    if (ids) ids.push(method.id);
    else byName.set(name, [method.id]);
  }

  return methods;
}

function indexBaseClasses(graph: IGraphContributor): Map<string, string[]> {
  const bases = new Map<string, string[]>();
  for (const rel of graph.relationshipsOfType("EXTENDS")) {
    const list = bases.get(rel.from);
    if (list) list.push(rel.to);
    else bases.set(rel.from, [rel.to]);
  }
  return bases;
}

function findMethod(
  classId: string,
  name: string,
  methodsByClassAndName: Map<string, Map<string, string[]>>,
  baseClassesByClass: Map<string, string[]>,
  visited: Set<string>,
): string | null {
  if (visited.has(classId)) return null;
  visited.add(classId);
  const own = methodsByClassAndName.get(classId)?.get(name)?.[0];
  if (own) return own;
  for (const baseId of baseClassesByClass.get(classId) ?? []) {
    const inherited = findMethod(baseId, name, methodsByClassAndName, baseClassesByClass, visited);
    if (inherited) return inherited;
  }
  return null;
}

function parameterNames(raw: unknown): Set<string> {
  if (typeof raw !== "string") return new Set();
  try {
    const parameters = JSON.parse(raw) as Array<{ name?: unknown }>;
    return new Set(parameters.flatMap((parameter) => typeof parameter.name === "string" ? [parameter.name] : []));
  } catch {
    return new Set();
  }
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

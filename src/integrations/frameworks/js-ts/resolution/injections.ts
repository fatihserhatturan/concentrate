import type { IGraphContributor } from "../../../../core/contracts/graph-contributor.js";
import type { GraphNode } from "../../../../core/graph/model.js";
import {
  createResolutionRelationshipIndex,
  indexImportNodesByFile,
  indexNodesByFileAndName,
} from "../../../../core/scan/resolution/indexes.js";

export function addInjectionRelationships(graph: IGraphContributor): void {
  // Injections and `this.field.method()` calls need a typed field and a class.
  if (graph.relationshipsOfType("DEFINES_FIELD").length === 0 || graph.nodesWithLabel("Class").length === 0) return;

  const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
  const classesByFileAndName = indexNodesByFileAndName(graph.nodes, relationshipIndex.fileByClassId, "Class");
  const functionsByClassAndName = indexMethodsByClassAndName(graph);
  const importsByFile = indexImportNodesByFile(graph.nodes, relationshipIndex.fileByImportId);
  const fieldsByClass = indexFieldsByClass(graph);
  const classIdByMethodId = indexClassIdByMethodId(graph);
  const callerFunctionByCallId = relationshipIndex.callerFunctionByCallId;
  const classIdByInjectedField = new Map<string, Map<string, string>>();

  for (const [classId, fields] of fieldsByClass) {
    const fileId = relationshipIndex.fileByClassId.get(classId);
    if (!fileId) continue;

    for (const field of fields) {
      const fieldName = field.properties.name;
      const typeName = field.properties.typeName;
      if (typeof fieldName !== "string" || typeof typeName !== "string") continue;

      const targetClassId = resolveClassName(
        typeName,
        fileId,
        classesByFileAndName,
        importsByFile,
        relationshipIndex.resolvedFileByImportId,
      );
      if (!targetClassId || targetClassId === classId) continue;

      let injectedFields = classIdByInjectedField.get(classId);
      if (!injectedFields) {
        injectedFields = new Map();
        classIdByInjectedField.set(classId, injectedFields);
      }
      injectedFields.set(fieldName, targetClassId);

      // Every typed field resolves this.field.method() calls, but only
      // constructor parameter properties and @Inject...() properties are
      // injected; an entity relation (`author: UserEntity`) is not a dependency.
      if (field.properties.isInjected !== true) continue;

      graph.addRelationship({
        from: classId,
        to: targetClassId,
        type: "INJECTS",
        properties: { fieldName },
      });
    }
  }

  for (const callNode of graph.nodesWithLabel("Call")) {
    const receiver = callNode.properties.receiver;
    const callee = callNode.properties.callee;
    if (typeof receiver !== "string" || typeof callee !== "string") continue;
    if (!receiver.startsWith("this.")) continue;

    const fieldName = receiver.slice("this.".length).split(".")[0];
    if (!fieldName) continue;

    const callerFunctionId = callerFunctionByCallId.get(callNode.id);
    if (!callerFunctionId) continue;

    const callerClassId = classIdByMethodId.get(callerFunctionId);
    if (!callerClassId) continue;

    const targetClassId = classIdByInjectedField.get(callerClassId)?.get(fieldName);
    if (!targetClassId) continue;

    const targetFunctionId = functionsByClassAndName.get(targetClassId)?.get(callee)?.[0];
    if (!targetFunctionId) continue;

    graph.addRelationship({
      from: callNode.id,
      to: targetFunctionId,
      type: "CALL_RESOLVES_TO",
      properties: {},
    });
  }
}

function indexFieldsByClass(graph: IGraphContributor): Map<string, GraphNode[]> {
  const fields = new Map<string, GraphNode[]>();

  for (const rel of graph.relationshipsOfType("DEFINES_FIELD")) {
    const field = graph.node(rel.to);
    if (field?.label !== "Field") continue;
    const list = fields.get(rel.from);
    if (list) list.push(field);
    else fields.set(rel.from, [field]);
  }

  return fields;
}

function indexClassIdByMethodId(graph: IGraphContributor): Map<string, string> {
  const classIds = new Map<string, string>();
  for (const rel of graph.relationshipsOfType("DEFINES_METHOD")) {
    classIds.set(rel.to, rel.from);
  }
  return classIds;
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

function resolveClassName(
  typeName: string,
  fileId: string,
  classesByFileAndName: Map<string, Map<string, string[]>>,
  importsByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  const name = normalizeTypeName(typeName);
  const sameFile = classesByFileAndName.get(fileId)?.get(name)?.[0];
  if (sameFile) return sameFile;

  for (const importNode of importsByFile.get(fileId) ?? []) {
    const targetFileId = resolvedFileByImportId.get(importNode.id);
    if (!targetFileId) continue;
    const imported = classesByFileAndName.get(targetFileId)?.get(name)?.[0];
    if (imported) return imported;
  }

  return null;
}

function normalizeTypeName(typeName: string): string {
  return typeName.replace(/<[\s\S]*>$/, "").split(".").at(-1)?.trim() ?? typeName.trim();
}

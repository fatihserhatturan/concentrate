import type { GraphNode, GraphRelationship } from "../../../../core/graph/model.js";
import { resolveDeclaration } from "../../../../core/scan/resolution/call-targets.js";
import { createResolutionRelationshipIndex, indexImportNodesByFile, type ResolutionRelationshipIndex } from "../../../../core/scan/resolution/indexes.js";

export type VariableResolver = {
  index: ResolutionRelationshipIndex;
  nodeById: Map<string, GraphNode>;
  fileByVariableId: Map<string, string>;
  // The Variable `name` refers to in `fileId`: declared there, or imported
  // by name or as the default export (`export default api`), through barrels.
  variableOf(name: string, fileId: string): GraphNode | undefined;
  // The file whose code makes a call (in a function or at the top level).
  fileOfCall(callId: string): string | undefined;
};

export function createVariableResolver(nodes: GraphNode[], relationships: GraphRelationship[]): VariableResolver {
  const index = createResolutionRelationshipIndex(relationships);
  const importNodesByFile = indexImportNodesByFile(nodes, index.fileByImportId);
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const fileByVariableId = new Map<string, string>();
  const variablesByFileAndName = new Map<string, Map<string, string[]>>();
  for (const rel of relationships) {
    const variable = rel.type === "DEFINES_VARIABLE" ? nodeById.get(rel.to) : undefined;
    if (variable?.label !== "Variable" || typeof variable.properties.name !== "string") continue;
    fileByVariableId.set(variable.id, rel.from);
    const byName = variablesByFileAndName.get(rel.from) ?? new Map<string, string[]>();
    byName.set(variable.properties.name, [...(byName.get(variable.properties.name) ?? []), variable.id]);
    variablesByFileAndName.set(rel.from, byName);
  }
  // `export default api` names a variable (and also records a "default"
  // export Variable, which the named one replaces).
  for (const [fileId, byName] of variablesByFileAndName) {
    const name = nodeById.get(fileId)?.properties.defaultExport;
    const ids = typeof name === "string" && name !== "default" ? byName.get(name) : undefined;
    if (ids) byName.set("default", ids);
  }
  return {
    index,
    nodeById,
    fileByVariableId,
    variableOf(name, fileId) {
      const id = resolveDeclaration(name, fileId, variablesByFileAndName, importNodesByFile, index.resolvedFileByImportId);
      return id ? nodeById.get(id) : undefined;
    },
    fileOfCall(callId) {
      const callerFunctionId = index.callerFunctionByCallId.get(callId);
      return index.callerFileByModuleCallId.get(callId) ?? (callerFunctionId ? index.fileByFunctionId.get(callerFunctionId) : undefined);
    },
  };
}

import type { GraphNode } from "../../../../core/graph/model.js";
import type { IGraphContributor } from "../../../../core/contracts/graph-contributor.js";
import { resolveDeclaration } from "../../../../core/scan/resolution/call-targets.js";
import { createResolutionRelationshipIndex, indexImportNodesByFile, type ResolutionRelationshipIndex } from "../../../../core/scan/resolution/indexes.js";

export type VariableResolver = {
  index: ResolutionRelationshipIndex;
  node(id: string): GraphNode | undefined;
  fileByVariableId: Map<string, string>;
  // The Variable `name` refers to in `fileId`: declared there, or imported
  // by name or as the default export (`export default api`), through barrels.
  variableOf(name: string, fileId: string): GraphNode | undefined;
  // The file whose code makes a call (in a function or at the top level).
  fileOfCall(callId: string): string | undefined;
};

export function createVariableResolver(graph: IGraphContributor): VariableResolver {
  const index = createResolutionRelationshipIndex(graph);
  const importNodesByFile = indexImportNodesByFile(graph.nodesWithLabel("Import"), index.fileByImportId);
  const fileByVariableId = new Map<string, string>();
  const variablesByFileAndName = new Map<string, Map<string, string[]>>();
  for (const rel of graph.relationshipsOfType("DEFINES_VARIABLE")) {
    const variable = graph.node(rel.to);
    if (variable?.label !== "Variable" || typeof variable.properties.name !== "string") continue;
    fileByVariableId.set(variable.id, rel.from);
    const byName = variablesByFileAndName.get(rel.from) ?? new Map<string, string[]>();
    byName.set(variable.properties.name, [...(byName.get(variable.properties.name) ?? []), variable.id]);
    variablesByFileAndName.set(rel.from, byName);
  }
  // `export default api` names a variable (and also records a "default"
  // export Variable, which the named one replaces).
  for (const [fileId, byName] of variablesByFileAndName) {
    const name = graph.node(fileId)?.properties.defaultExport;
    const ids = typeof name === "string" && name !== "default" ? byName.get(name) : undefined;
    if (ids) byName.set("default", ids);
  }
  return {
    index,
    node: (id) => graph.node(id),
    fileByVariableId,
    variableOf(name, fileId) {
      const id = resolveDeclaration(name, fileId, variablesByFileAndName, importNodesByFile, index.resolvedFileByImportId);
      return id ? graph.node(id) : undefined;
    },
    fileOfCall(callId) {
      const callerFunctionId = index.callerFunctionByCallId.get(callId);
      return index.callerFileByModuleCallId.get(callId) ?? (callerFunctionId ? index.fileByFunctionId.get(callerFunctionId) : undefined);
    },
  };
}

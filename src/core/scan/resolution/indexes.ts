import type { GraphRelationship } from "../../graph/model.js";
export {
  indexImportNodesByFile,
  indexNodesByFileAndName,
} from "./node-indexes.js";

export type ResolutionRelationshipIndex = {
  callerFunctionByCallId: Map<string, string>;
  // Module-level calls: the file whose top-level code makes the call.
  callerFileByModuleCallId: Map<string, string>;
  fileByFunctionId: Map<string, string>;
  fileByClassId: Map<string, string>;
  fileByInterfaceId: Map<string, string>;
  fileByImportId: Map<string, string>;
  resolvedFileByImportId: Map<string, string>;
};

type RelationshipSource = {
  relationshipsOfType(type: GraphRelationship["type"]): readonly GraphRelationship[];
};

const INDEXED_TYPES: GraphRelationship["type"][] = [
  "CALLS",
  "MODULE_CALLS",
  "DEFINES_FUNCTION",
  "DEFINES_CLASS",
  "DEFINES_INTERFACE",
  "IMPORTS",
  "RESOLVES_TO",
  "DEFINES_VARIABLE",
  "INITIALIZED_BY",
  "DEFINES_METHOD",
];

// Pass the graph to read only the types needed through its lookups; a plain
// array is grouped by type in one pass first.
export function createResolutionRelationshipIndex(
  source: readonly GraphRelationship[] | RelationshipSource,
): ResolutionRelationshipIndex {
  const of: RelationshipSource = Array.isArray(source)
    ? groupByType(source as readonly GraphRelationship[])
    : (source as RelationshipSource);
  const index: ResolutionRelationshipIndex = {
    callerFunctionByCallId: new Map(),
    callerFileByModuleCallId: new Map(),
    fileByFunctionId: new Map(),
    fileByClassId: new Map(),
    fileByInterfaceId: new Map(),
    fileByImportId: new Map(),
    resolvedFileByImportId: new Map(),
  };

  for (const rel of of.relationshipsOfType("CALLS")) index.callerFunctionByCallId.set(rel.to, rel.from);
  for (const rel of of.relationshipsOfType("MODULE_CALLS")) index.callerFileByModuleCallId.set(rel.to, rel.from);
  for (const rel of of.relationshipsOfType("DEFINES_FUNCTION")) index.fileByFunctionId.set(rel.to, rel.from);
  for (const rel of of.relationshipsOfType("DEFINES_CLASS")) index.fileByClassId.set(rel.to, rel.from);
  for (const rel of of.relationshipsOfType("DEFINES_INTERFACE")) index.fileByInterfaceId.set(rel.to, rel.from);
  for (const rel of of.relationshipsOfType("IMPORTS")) index.fileByImportId.set(rel.to, rel.from);
  for (const rel of of.relationshipsOfType("RESOLVES_TO")) index.resolvedFileByImportId.set(rel.from, rel.to);

  // A call initializing a file-level variable (`const ky = createInstance()`)
  // is made by the file's top-level code too.
  const fileByVariableId = new Map<string, string>();
  for (const rel of of.relationshipsOfType("DEFINES_VARIABLE")) fileByVariableId.set(rel.to, rel.from);
  for (const rel of of.relationshipsOfType("INITIALIZED_BY")) {
    const fileId = fileByVariableId.get(rel.from);
    if (fileId && !index.callerFunctionByCallId.has(rel.to)) index.callerFileByModuleCallId.set(rel.to, fileId);
  }

  for (const rel of of.relationshipsOfType("DEFINES_METHOD")) {
    const fileId = index.fileByClassId.get(rel.from);
    if (fileId) {
      index.fileByFunctionId.set(rel.to, fileId);
    }
  }

  return index;
}

function groupByType(relationships: readonly GraphRelationship[]): RelationshipSource {
  const wanted = new Set<string>(INDEXED_TYPES);
  const byType = new Map<string, GraphRelationship[]>();
  for (const rel of relationships) {
    if (!wanted.has(rel.type)) continue;
    const list = byType.get(rel.type);
    if (list) list.push(rel);
    else byType.set(rel.type, [rel]);
  }
  return { relationshipsOfType: (type) => byType.get(type) ?? [] };
}

import type { GraphRelationship } from "../../graph/model.js";
export {
  indexImportNodesByFile,
  indexNodesByFileAndName,
} from "./node-indexes.js";

export type ResolutionRelationshipIndex = {
  callerFunctionByCallId: Map<string, string>;
  fileByFunctionId: Map<string, string>;
  fileByClassId: Map<string, string>;
  fileByInterfaceId: Map<string, string>;
  fileByImportId: Map<string, string>;
  resolvedFileByImportId: Map<string, string>;
};

export function createResolutionRelationshipIndex(
  relationships: GraphRelationship[],
): ResolutionRelationshipIndex {
  const index: ResolutionRelationshipIndex = {
    callerFunctionByCallId: new Map(),
    fileByFunctionId: new Map(),
    fileByClassId: new Map(),
    fileByInterfaceId: new Map(),
    fileByImportId: new Map(),
    resolvedFileByImportId: new Map(),
  };

  for (const rel of relationships) {
    switch (rel.type) {
      case "CALLS":
        index.callerFunctionByCallId.set(rel.to, rel.from);
        break;
      case "DEFINES_FUNCTION":
        index.fileByFunctionId.set(rel.to, rel.from);
        break;
      case "DEFINES_CLASS":
        index.fileByClassId.set(rel.to, rel.from);
        break;
      case "DEFINES_INTERFACE":
        index.fileByInterfaceId.set(rel.to, rel.from);
        break;
      case "IMPORTS":
        index.fileByImportId.set(rel.to, rel.from);
        break;
      case "RESOLVES_TO":
        index.resolvedFileByImportId.set(rel.from, rel.to);
        break;
    }
  }

  for (const rel of relationships) {
    if (rel.type !== "DEFINES_METHOD") {
      continue;
    }

    const fileId = index.fileByClassId.get(rel.from);
    if (fileId) {
      index.fileByFunctionId.set(rel.to, fileId);
    }
  }

  return index;
}

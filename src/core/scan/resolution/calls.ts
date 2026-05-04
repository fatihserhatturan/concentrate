import { GraphBuilder } from "../../graph/builder.js";
import { resolveCall } from "./call-targets.js";
import {
  createResolutionRelationshipIndex,
  indexImportNodesByFile,
  indexNodesByFileAndName,
} from "./indexes.js";

export function addCallResolutionRelationships(graph: GraphBuilder): {
  resolved: number;
  unresolved: number;
} {
  const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
  const functionsByFileAndName = indexNodesByFileAndName(
    graph.nodes,
    relationshipIndex.fileByFunctionId,
    "Function",
  );
  const importNodesByFile = indexImportNodesByFile(graph.nodes, relationshipIndex.fileByImportId);

  let resolved = 0;
  let unresolved = 0;

  for (const node of graph.nodes) {
    if (node.label !== "Call") continue;

    const callee = node.properties.callee as string | null;
    const receiver = node.properties.receiver as string | null;
    if (!callee) {
      unresolved++;
      continue;
    }

    const callerFunctionId = relationshipIndex.callerFunctionByCallId.get(node.id);
    if (!callerFunctionId) {
      unresolved++;
      continue;
    }

    const callerFileId = relationshipIndex.fileByFunctionId.get(callerFunctionId);
    if (!callerFileId) {
      unresolved++;
      continue;
    }

    const targetFunctionId = resolveCall(
      callee,
      receiver,
      callerFileId,
      functionsByFileAndName,
      importNodesByFile,
      relationshipIndex.resolvedFileByImportId,
    );

    if (!targetFunctionId) {
      unresolved++;
      continue;
    }

    graph.addRelationship({
      from: node.id,
      to: targetFunctionId,
      type: "CALL_RESOLVES_TO",
      properties: {},
    });
    resolved++;
  }

  return { resolved, unresolved };
}

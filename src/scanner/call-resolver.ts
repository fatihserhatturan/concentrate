import { GraphBuilder } from "../graph/builder.js";
import type { GraphNode } from "../graph/model.js";

export function addCallResolutionRelationships(graph: GraphBuilder): {
  resolved: number;
  unresolved: number;
} {
  // callId → functionId (the function that contains the call)
  const callerFunctionByCallId = new Map<string, string>();
  // functionId → fileId
  const fileByFunctionId = new Map<string, string>();
  // classId → fileId
  const fileByClassId = new Map<string, string>();
  // importId → fileId (the file that contains the import)
  const fileByImportId = new Map<string, string>();
  // importId → targetFileId (resolved file)
  const resolvedFileByImportId = new Map<string, string>();

  for (const rel of graph.relationships) {
    switch (rel.type) {
      case "CALLS":
        callerFunctionByCallId.set(rel.to, rel.from);
        break;
      case "DEFINES_FUNCTION":
        fileByFunctionId.set(rel.to, rel.from);
        break;
      case "DEFINES_CLASS":
        fileByClassId.set(rel.to, rel.from);
        break;
      case "IMPORTS":
        fileByImportId.set(rel.to, rel.from);
        break;
      case "RESOLVES_TO":
        resolvedFileByImportId.set(rel.from, rel.to);
        break;
    }
  }

  // DEFINES_METHOD: functionId → classId → fileId
  for (const rel of graph.relationships) {
    if (rel.type === "DEFINES_METHOD") {
      const fileId = fileByClassId.get(rel.from);
      if (fileId) {
        fileByFunctionId.set(rel.to, fileId);
      }
    }
  }

  // fileId → name → functionId[]
  const functionsByFileAndName = new Map<string, Map<string, string[]>>();
  for (const node of graph.nodes) {
    if (node.label !== "Function") continue;
    const fileId = fileByFunctionId.get(node.id);
    if (!fileId) continue;
    const name = node.properties.name as string;
    let byName = functionsByFileAndName.get(fileId);
    if (!byName) {
      byName = new Map();
      functionsByFileAndName.set(fileId, byName);
    }
    const list = byName.get(name) ?? [];
    list.push(node.id);
    byName.set(name, list);
  }

  // fileId → Import nodes
  const importNodesByFile = new Map<string, GraphNode[]>();
  for (const node of graph.nodes) {
    if (node.label !== "Import") continue;
    const fileId = fileByImportId.get(node.id);
    if (!fileId) continue;
    const list = importNodesByFile.get(fileId) ?? [];
    list.push(node);
    importNodesByFile.set(fileId, list);
  }

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

    const callerFunctionId = callerFunctionByCallId.get(node.id);
    if (!callerFunctionId) {
      unresolved++;
      continue;
    }

    const callerFileId = fileByFunctionId.get(callerFunctionId);
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
      resolvedFileByImportId,
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

function resolveCall(
  callee: string,
  receiver: string | null,
  callerFileId: string,
  functionsByFileAndName: Map<string, Map<string, string[]>>,
  importNodesByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  if (!receiver || receiver === "self" || receiver === "this") {
    // Try same-file first
    const sameFile = lookupFunctionInFile(callee, callerFileId, functionsByFileAndName);
    if (sameFile) return sameFile;

    // Named import with no receiver: scan imports for a resolved file that defines callee
    if (!receiver) {
      const imports = importNodesByFile.get(callerFileId) ?? [];
      for (const importNode of imports) {
        const targetFileId = resolvedFileByImportId.get(importNode.id);
        if (!targetFileId) continue;
        const found = lookupFunctionInFile(callee, targetFileId, functionsByFileAndName);
        if (found) return found;
      }
    }
    return null;
  }

  // Receiver-based: look for an import whose alias matches the receiver
  const imports = importNodesByFile.get(callerFileId) ?? [];
  for (const importNode of imports) {
    const alias = extractImportAlias(importNode.properties.specifier as string);
    if (alias !== receiver) continue;
    const targetFileId = resolvedFileByImportId.get(importNode.id);
    if (!targetFileId) continue;
    const found = lookupFunctionInFile(callee, targetFileId, functionsByFileAndName);
    if (found) return found;
  }

  return null;
}

function lookupFunctionInFile(
  name: string,
  fileId: string,
  functionsByFileAndName: Map<string, Map<string, string[]>>,
): string | null {
  return functionsByFileAndName.get(fileId)?.get(name)?.[0] ?? null;
}

// Extract the local alias from an import statement text.
// Handles: import * as Alias from '...'  and  import DefaultAlias from '...'
function extractImportAlias(specifierText: string): string | null {
  const nsMatch = specifierText.match(/\bimport\s+\*\s+as\s+(\w+)\b/);
  if (nsMatch) return nsMatch[1] ?? null;

  const defaultMatch = specifierText.match(/\bimport\s+(\w+)\s+from\b/);
  if (defaultMatch) return defaultMatch[1] ?? null;

  return null;
}

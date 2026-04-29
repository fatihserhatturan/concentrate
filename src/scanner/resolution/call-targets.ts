import type { GraphNode, ImportBinding } from "../../graph/model.js";

export function resolveCall(
  callee: string,
  receiver: string | null,
  callerFileId: string,
  functionsByFileAndName: Map<string, Map<string, string[]>>,
  importNodesByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  if (!receiver || receiver === "self" || receiver === "this") {
    const sameFile = lookupFunctionInFile(callee, callerFileId, functionsByFileAndName);
    if (sameFile) return sameFile;
    return receiver ? null : resolveImportedFreeCall(callee, callerFileId, functionsByFileAndName, importNodesByFile, resolvedFileByImportId);
  }

  return resolveReceiverCall(callee, receiver, callerFileId, functionsByFileAndName, importNodesByFile, resolvedFileByImportId);
}

function resolveImportedFreeCall(
  callee: string,
  callerFileId: string,
  functionsByFileAndName: Map<string, Map<string, string[]>>,
  importNodesByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  for (const importNode of importNodesByFile.get(callerFileId) ?? []) {
    const targetFileId = resolvedFileByImportId.get(importNode.id);
    if (!targetFileId) continue;

    const bindings = parseBindings(importNode);
    if (!bindings) {
      const found = lookupFunctionInFile(callee, targetFileId, functionsByFileAndName);
      if (found) return found;
      continue;
    }

    const binding = bindings.find((b) => b.kind === "named" && b.local === callee);
    if (!binding) continue;
    const found = lookupFunctionInFile(binding.imported, targetFileId, functionsByFileAndName);
    if (found) return found;
  }

  return null;
}

function resolveReceiverCall(
  callee: string,
  receiver: string,
  callerFileId: string,
  functionsByFileAndName: Map<string, Map<string, string[]>>,
  importNodesByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  for (const importNode of importNodesByFile.get(callerFileId) ?? []) {
    const targetFileId = resolvedFileByImportId.get(importNode.id);
    if (!targetFileId || !importMatchesReceiver(importNode, receiver)) continue;

    const found = lookupFunctionInFile(callee, targetFileId, functionsByFileAndName);
    if (found) return found;
  }

  return null;
}

function importMatchesReceiver(importNode: GraphNode, receiver: string): boolean {
  const bindings = parseBindings(importNode);
  if (bindings) {
    return bindings.some((b) => (b.kind === "namespace" || b.kind === "default") && b.local === receiver);
  }

  return extractImportAlias(importNode.properties.specifier as string) === receiver;
}

function parseBindings(importNode: GraphNode): ImportBinding[] | null {
  const raw = importNode.properties.bindings;
  if (typeof raw !== "string") return null;
  return JSON.parse(raw) as ImportBinding[];
}

function lookupFunctionInFile(
  name: string,
  fileId: string,
  functionsByFileAndName: Map<string, Map<string, string[]>>,
): string | null {
  return functionsByFileAndName.get(fileId)?.get(name)?.[0] ?? null;
}

function extractImportAlias(specifierText: string): string | null {
  const nsMatch = specifierText.match(/\bimport\s+\*\s+as\s+(\w+)\b/);
  if (nsMatch) return nsMatch[1] ?? null;

  const defaultMatch = specifierText.match(/\bimport\s+(\w+)\s+from\b/);
  return defaultMatch?.[1] ?? null;
}

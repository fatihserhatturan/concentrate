import type { GraphNode, ImportBinding } from "../../graph/model.js";
import { parseNamespaceReExport, parseReExportNames } from "../../graph/re-exports.js";

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

// A declaration called `name` as seen from `fileId`: defined there, or
// imported by name or as the default export, through barrels. Works for any
// by-file-and-name index (functions, classes).
export function resolveDeclaration(
  name: string,
  fileId: string,
  declarationsByFileAndName: Map<string, Map<string, string[]>>,
  importNodesByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  return lookupFunctionInFile(name, fileId, declarationsByFileAndName)
    ?? resolveImportedFreeCall(name, fileId, declarationsByFileAndName, importNodesByFile, resolvedFileByImportId);
}

export function resolveImportedFreeCall(
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
      const found = lookupExportedFunction(callee, targetFileId, functionsByFileAndName, importNodesByFile, resolvedFileByImportId);
      if (found) return found;
      continue;
    }

    const binding = bindings.find((b) => (b.kind === "named" || b.kind === "default") && b.local === callee);
    if (!binding) continue;
    const found = lookupExportedFunction(binding.imported, targetFileId, functionsByFileAndName, importNodesByFile, resolvedFileByImportId);
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

    const found = lookupExportedFunction(callee, targetFileId, functionsByFileAndName, importNodesByFile, resolvedFileByImportId);
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

// Results of lookupExportedFunction per declaration index (one per graph
// scan and declaration kind), keyed by file and name.
const exportedFunctionCache = new WeakMap<object, Map<string, string | null>>();

// A function `name` that `fileId` exports: defined in the file itself, or
// reached through its `export * from` and `export { a as name } from`
// re-exports (barrels), followed across files and packages.
function lookupExportedFunction(
  name: string,
  fileId: string,
  functionsByFileAndName: Map<string, Map<string, string[]>>,
  importNodesByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  let cache = exportedFunctionCache.get(functionsByFileAndName);
  if (!cache) {
    cache = new Map();
    exportedFunctionCache.set(functionsByFileAndName, cache);
  }
  const key = `${fileId}\0${name}`;
  if (cache.has(key)) return cache.get(key)!;
  const found = followReExports(name, fileId, functionsByFileAndName, importNodesByFile, resolvedFileByImportId, new Set());
  cache.set(key, found);
  return found;
}

function followReExports(
  name: string,
  fileId: string,
  functionsByFileAndName: Map<string, Map<string, string[]>>,
  importNodesByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
  visited: Set<string>,
): string | null {
  const key = `${fileId}\0${name}`;
  if (visited.has(key)) return null; // export * cycles
  visited.add(key);

  const own = lookupFunctionInFile(name, fileId, functionsByFileAndName);
  if (own) return own;

  for (const importNode of importNodesByFile.get(fileId) ?? []) {
    if (importNode.properties.isReExport !== true) continue;
    const targetFileId = resolvedFileByImportId.get(importNode.id);
    if (!targetFileId) continue;

    const specifier = String(importNode.properties.specifier ?? "");
    const forwarded = importNode.properties.isWildcard === true
      ? parseNamespaceReExport(specifier) === null && name !== "default" ? name : null
      : parseReExportNames(specifier).find((entry) => entry.exported === name)?.imported ?? null;
    if (forwarded === null) continue;

    const found = followReExports(forwarded, targetFileId, functionsByFileAndName, importNodesByFile, resolvedFileByImportId, visited);
    if (found) return found;
  }

  return null;
}

function extractImportAlias(specifierText: string): string | null {
  const nsMatch = specifierText.match(/\bimport\s+\*\s+as\s+(\w+)\b/);
  if (nsMatch) return nsMatch[1] ?? null;

  const defaultMatch = specifierText.match(/\bimport\s+(\w+)\s+from\b/);
  return defaultMatch?.[1] ?? null;
}

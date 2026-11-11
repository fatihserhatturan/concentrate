import type { GraphNode, ImportBinding } from "../../graph/model.js";

type Declarations = Map<string, Map<string, string[]>>;

// A name as Python sees it from a file: declared there, or bound by an import
// (`from m import x as y`, `import a.b as c`, `from m import *`), followed
// through the modules that re-export it (`__init__.py`). A dotted name goes
// through the module its first part names: `models.User`, `pkg.models.User`.
export type PythonNameLookup = (name: string, fileId: string) => string | null;

export function createPythonNameLookup(
  declarations: Declarations,
  importsByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): PythonNameLookup {
  const lookup = (name: string, fileId: string, seen: Set<string>): string | null => {
    const key = `${fileId}\0${name}`;
    if (seen.has(key) || seen.size > 64) return null;
    seen.add(key);

    const segments = name.split(".");
    if (segments.length === 1) {
      const own = declarations.get(fileId)?.get(name)?.[0];
      if (own) return own;
    }

    const wildcards: string[] = [];
    for (const importNode of importsByFile.get(fileId) ?? []) {
      const target = resolvedFileByImportId.get(importNode.id);
      if (!target) continue;
      if (importNode.properties.isWildcard === true) {
        wildcards.push(target);
        continue;
      }
      for (const binding of parseBindings(importNode)) {
        if (segments.length === 1) {
          // `from m import x [as y]` binds `y` to what `m` calls `x`.
          if (binding.kind !== "named" || binding.local !== name || importNode.properties.isModule === true) continue;
          const found = lookup(binding.imported, target, seen);
          if (found) return found;
        } else if (binding.local === segments[0] || (binding.kind === "namespace" && name.startsWith(`${binding.local}.`))) {
          // The first part names a module: the rest is looked up inside it.
          const isModuleBinding = binding.kind === "namespace" || importNode.properties.isModule === true;
          if (!isModuleBinding) continue;
          const prefixLength = binding.local === segments[0] ? 1 : binding.local.split(".").length;
          const found = lookup(segments.slice(prefixLength).join("."), target, seen);
          if (found) return found;
        }
      }
    }

    if (segments.length === 1) {
      for (const target of wildcards) {
        const found = lookup(name, target, seen);
        if (found) return found;
      }
    }
    return null;
  };

  return (name, fileId) => lookup(name, fileId, new Set());
}

function parseBindings(importNode: GraphNode): ImportBinding[] {
  const raw = importNode.properties.bindings;
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw) as ImportBinding[];
  } catch {
    return [];
  }
}

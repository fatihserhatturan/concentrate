import type { SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";

// One `Import` per imported module (`import a, b as c`) and per imported name
// (`from m import x, y as z`), with the dotted module as written, leading dots
// included: `pkg.mod`, `.sibling`, `..parent.mod`, `.`.
//   - `bindings` lists what the statement binds in the file (same shape as JS/TS).
//   - `alias` is the `as` name; `isWildcard` marks `from m import *`.
//   - `isTypeOnly` marks imports under `if TYPE_CHECKING:`.
export function createPythonImportNodes(fileNodeId: string, node: SyntaxNode, ids: Set<string>): GraphNode[] {
  const line = node.startPosition.row + 1;
  const isTypeOnly = isUnderTypeChecking(node);
  const make = (source: string, extra: Record<string, unknown>): GraphNode => {
    let id = `${fileNodeId}:import:${line}:${source}`;
    for (let n = 2; ids.has(id); n += 1) id = `${fileNodeId}:import:${line}:${source}#${n}`;
    ids.add(id);
    return {
      id,
      label: "Import",
      properties: { source, specifier: node.text, line, ...(isTypeOnly ? { isTypeOnly: true } : {}), ...extra },
    } as GraphNode;
  };

  if (node.type === "import_statement") {
    return node.namedChildren.flatMap((child) => {
      const { module, alias } = moduleAndAlias(child);
      if (!module) return [];
      // `import a.b` binds `a`, and `a.b.f()` reads as the receiver `a.b`; `import a.b as c` binds `c`.
      const local = alias ?? module;
      return [make(module, {
        ...(alias ? { alias } : {}),
        bindings: JSON.stringify([{ imported: module, local, kind: "namespace" }]),
      })];
    });
  }

  const moduleNode = node.childForFieldName("module_name");
  if (!moduleNode) return [];
  const source = moduleNode.type === "relative_import" ? moduleNode.text.replace(/\s+/gu, "") : moduleNode.text;
  const imported = node.namedChildren.filter((child) => child.id !== moduleNode.id);
  if (imported.some((child) => child.type === "wildcard_import")) return [make(source, { isWildcard: true })];

  return imported.flatMap((child) => {
    const { module: name, alias } = moduleAndAlias(child);
    if (!name) return [];
    return [make(source, {
      ...(alias ? { alias } : {}),
      bindings: JSON.stringify([{ imported: name, local: alias ?? name, kind: "named" }]),
    })];
  });
}

function moduleAndAlias(node: SyntaxNode): { module: string | null; alias: string | null } {
  if (node.type === "aliased_import") {
    return { module: node.childForFieldName("name")?.text ?? null, alias: node.childForFieldName("alias")?.text ?? null };
  }
  return node.type === "dotted_name" ? { module: node.text, alias: null } : { module: null, alias: null };
}

function isUnderTypeChecking(node: SyntaxNode): boolean {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "function_definition" || parent.type === "class_definition") return false;
    if (parent.type === "if_statement") {
      const condition = parent.childForFieldName("condition")?.text.trim();
      if (condition === "TYPE_CHECKING" || condition === "typing.TYPE_CHECKING") return true;
    }
  }
  return false;
}

// `__all__ = ["a", "b"]`, `__all__ += ["c"]` and `__all__.extend([...])` at module level.
export function readDunderAll(root: SyntaxNode): string[] | null {
  let found = false;
  const names: string[] = [];
  const addStrings = (items: SyntaxNode[]) => {
    for (const item of items) {
      if (item.type !== "string") continue;
      const value = /^[rbuRBU]*(["']{1,3})([\s\S]*?)\1$/u.exec(item.text)?.[2];
      if (value) names.push(value);
    }
  };
  const addList = (list: SyntaxNode | null) => {
    if (list && (list.type === "list" || list.type === "tuple")) addStrings(list.namedChildren);
  };
  for (const statement of root.namedChildren) {
    if (statement.type !== "expression_statement") continue;
    const expression = statement.namedChildren[0];
    if (!expression) continue;
    if ((expression.type === "assignment" || expression.type === "augmented_assignment") && expression.childForFieldName("left")?.text === "__all__") {
      found = true;
      addList(expression.childForFieldName("right"));
    } else if (expression.type === "call") {
      const fn = expression.childForFieldName("function")?.text;
      if (fn === "__all__.extend" || fn === "__all__.append") {
        found = true;
        const argument = expression.childForFieldName("arguments")?.namedChildren[0] ?? null;
        if (fn === "__all__.extend") addList(argument);
        else if (argument) addStrings([argument]);
      }
    }
  }
  return found ? [...new Set(names)] : null;
}

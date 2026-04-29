import type Parser from "tree-sitter";
import type { ImportBinding } from "../../graph/model.js";

export function extractCjsBindings(requireCall: Parser.SyntaxNode): string | null {
  const declarator = requireCall.parent;
  if (!declarator || declarator.type !== "variable_declarator") {
    return null;
  }

  const nameNode = declarator.childForFieldName("name");
  if (!nameNode) {
    return null;
  }

  if (nameNode.type === "object_pattern") {
    const bindings = extractObjectPatternBindings(nameNode);
    return bindings.length > 0 ? JSON.stringify(bindings) : null;
  }

  if (nameNode.type === "identifier") {
    return JSON.stringify([{ imported: "default", local: nameNode.text, kind: "default" }]);
  }

  return null;
}

export function serializeImportBindings(node: Parser.SyntaxNode): string | null {
  const importClause = node.namedChildren.find((c) => c.type === "import_clause");
  if (!importClause) {
    return null;
  }

  const bindings = importClause.namedChildren.flatMap(extractImportClauseBindings);
  return bindings.length > 0 ? JSON.stringify(bindings) : null;
}

function extractObjectPatternBindings(nameNode: Parser.SyntaxNode): ImportBinding[] {
  const bindings: ImportBinding[] = [];
  for (const child of nameNode.namedChildren) {
    if (child.type === "shorthand_property_identifier_pattern") {
      bindings.push({ imported: child.text, local: child.text, kind: "named" });
    } else if (child.type === "pair_pattern") {
      const key = child.childForFieldName("key");
      const value = child.childForFieldName("value");
      if (key && value) {
        bindings.push({ imported: key.text, local: value.text, kind: "named" });
      }
    }
  }
  return bindings;
}

function extractImportClauseBindings(child: Parser.SyntaxNode): ImportBinding[] {
  if (child.type === "identifier") {
    return [{ imported: "default", local: child.text, kind: "default" }];
  }

  if (child.type === "namespace_import") {
    const nameNode = child.childForFieldName("alias") ?? child.namedChildren.find((c) => c.type === "identifier");
    return nameNode ? [{ imported: "*", local: nameNode.text, kind: "namespace" }] : [];
  }

  if (child.type !== "named_imports") {
    return [];
  }

  return child.namedChildren
    .filter((specifier) => specifier.type === "import_specifier")
    .flatMap(extractNamedImportBinding);
}

function extractNamedImportBinding(specifier: Parser.SyntaxNode): ImportBinding[] {
  const nameNode = specifier.childForFieldName("name");
  const aliasNode = specifier.childForFieldName("alias");
  return nameNode
    ? [{ imported: nameNode.text, local: aliasNode?.text ?? nameNode.text, kind: "named" }]
    : [];
}

import type { SyntaxNode } from "../syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { walk } from "../tree-sitter-utils.js";

// Env reads: `process.env.NAME`, `process.env["NAME"]`, the same on
// `import.meta.env` (Vite, Astro; built-ins such as `MODE` and `DEV` too),
// and destructuring, `const { PORT, DB: url = "…" } = process.env` (access
// `destructure`, one read per key; a `...rest` element is skipped). An env
// var whose name has a client-exposed prefix (`NEXT_PUBLIC_`, `VITE_`, …) is
// marked `isPublic`.

const publicPrefixes = /^(?:NEXT_PUBLIC_|VITE_|NUXT_PUBLIC_|PUBLIC_|REACT_APP_|EXPO_PUBLIC_|GATSBY_)/u;

type EnvAccess = {
  name: string;
  line: number;
  access: string;
};

export function createFileEnvUsageGraph(
  fileNodeId: string,
  programNode: SyntaxNode,
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  const accesses = extractEnvAccesses(programNode);
  return createEnvUsageGraph(fileNodeId, accesses);
}

export function createFunctionEnvUsageGraph(
  functionNodeId: string,
  functionNode: SyntaxNode,
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  const accesses = extractEnvAccesses(functionNode);
  return createEnvUsageGraph(functionNodeId, accesses);
}

export function createConfigValueGraph(
  fileNodeId: string,
  declarator: SyntaxNode,
): { node: GraphNode; relationship: GraphRelationship } | null {
  const declaration = declarator.parent;
  const nameNode = declarator.childForFieldName("name");
  const valueNode = declarator.childForFieldName("value");
  if (
    !declaration
    || (declaration.type !== "variable_declaration" && declaration.type !== "lexical_declaration")
    || declaration.parent?.type !== "export_statement"
  ) {
    return null;
  }
  if (nameNode?.type !== "identifier" || !valueNode) {
    return null;
  }

  const value = extractLiteralValue(valueNode);
  if (!value) {
    return null;
  }

  const node: GraphNode = {
    id: `${fileNodeId}:config:${declarator.startPosition.row + 1}:${nameNode.text}`,
    label: "ConfigValue",
    properties: {
      name: nameNode.text,
      value: value.value,
      valueType: value.type,
      line: declarator.startPosition.row + 1,
    },
  };

  return {
    node,
    relationship: {
      from: fileNodeId,
      to: node.id,
      type: "DECLARES_CONFIG",
      properties: {},
    },
  };
}

function createEnvUsageGraph(
  sourceNodeId: string,
  accesses: EnvAccess[],
): { nodes: GraphNode[]; relationships: GraphRelationship[] } {
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  const seen = new Set<string>();

  for (const access of accesses) {
    const key = `${sourceNodeId}:${access.name}:${access.line}:${access.access}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const envNode: GraphNode = {
      id: `env:${access.name}`,
      label: "EnvVar",
      properties: {
        name: access.name,
        ...(publicPrefixes.test(access.name) ? { isPublic: true } : {}),
      },
    };
    nodes.push(envNode);
    relationships.push({
      from: sourceNodeId,
      to: envNode.id,
      type: "USES_ENV",
      properties: {
        line: access.line,
        access: access.access,
      },
    });
  }

  return { nodes, relationships };
}

function extractEnvAccesses(node: SyntaxNode): EnvAccess[] {
  const accesses: EnvAccess[] = [];
  walk(node, (child) => {
    if (child.type === "variable_declarator") {
      accesses.push(...extractDestructuredEnvAccesses(child));
      return;
    }
    if (child.type !== "member_expression" && child.type !== "subscript_expression") {
      return;
    }

    accesses.push(...extractEnvAccessesFromText(child.text, child.startPosition.row + 1));
  });

  return dedupeEnvAccesses(accesses);
}

// `const { PORT, DATABASE_URL: url = "…" } = process.env`
function extractDestructuredEnvAccesses(declarator: SyntaxNode): EnvAccess[] {
  const pattern = declarator.childForFieldName("name");
  const value = declarator.childForFieldName("value");
  if (pattern?.type !== "object_pattern" || !value || !/^(?:process|import\.meta)\.env$/u.test(value.text)) {
    return [];
  }

  const accesses: EnvAccess[] = [];
  for (const property of pattern.namedChildren) {
    let key: SyntaxNode | null | undefined = null;
    if (property?.type === "shorthand_property_identifier_pattern") key = property;
    else if (property?.type === "object_assignment_pattern") key = property.childForFieldName("left");
    else if (property?.type === "pair_pattern") key = property.childForFieldName("key");
    if (!key || !property) continue;
    const name = key.type === "string" ? key.text.slice(1, -1) : key.text;
    if (name) accesses.push({ name, line: property.startPosition.row + 1, access: "destructure" });
  }
  return accesses;
}

function extractEnvAccessesFromText(text: string, line: number): EnvAccess[] {
  const accesses: EnvAccess[] = [];
  for (const match of text.matchAll(/\b(?:process|import\.meta)\.env\.([A-Za-z_]\w*)\b/g)) {
    accesses.push({
      name: match[1]!,
      line,
      access: "member",
    });
  }

  for (const match of text.matchAll(/\b(?:process|import\.meta)\.env\[['"`]([^'"`]+)['"`]\]/g)) {
    accesses.push({
      name: match[1]!,
      line,
      access: "subscript",
    });
  }

  return accesses;
}

function dedupeEnvAccesses(accesses: EnvAccess[]): EnvAccess[] {
  const seen = new Set<string>();
  return accesses.filter((access) => {
    const key = `${access.name}:${access.line}:${access.access}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function extractLiteralValue(node: SyntaxNode): { value: string; type: string } | null {
  if (node.type === "string") {
    return {
      value: node.text.replace(/^["'`]|["'`]$/g, ""),
      type: "string",
    };
  }

  if (node.type === "number") {
    return {
      value: node.text,
      type: "number",
    };
  }

  if (node.type === "true" || node.type === "false") {
    return {
      value: node.type,
      type: "boolean",
    };
  }

  return null;
}

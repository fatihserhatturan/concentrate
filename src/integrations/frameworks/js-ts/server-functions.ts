import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import { createEntrypointNode } from "./entrypoint-graph.js";

// React Server Functions (Next.js server actions): a module whose directive
// prologue holds "use server" makes every exported function one; a function
// whose body starts with "use server" is one on its own. Each becomes an
// EntryPoint of kind `server-action` (library `react`, the directive is
// React's), handled by that function, since the client calls it over the
// network. Functions without a Function node (nested in another function)
// are left out.

export function applyServerFunctionSemantics({ fileNodeId, rootNode, parsed, state }: JsTsParsedFile): void {
  const moduleLevel = hasUseServer(rootNode);
  const exportedFunctionIds = new Set(
    parsed.relationships
      .filter((rel) => rel.type === "DEFINES_FUNCTION" && rel.from === fileNodeId)
      .map((rel) => rel.to),
  );
  const nodesById = new Map(parsed.nodes.map((node) => [node.id, node]));

  for (const { functionNodeId, astNode } of state.functionAstPairs) {
    const fn = nodesById.get(functionNodeId);
    if (!fn) continue;
    const name = fn.properties.name;
    const exported = exportedFunctionIds.has(functionNodeId) && fn.properties.isExported === true;
    const body = astNode.childForFieldName("body");
    const own = body?.type === "statement_block" && hasUseServer(body);
    if (!own && !(moduleLevel && exported)) continue;

    const entrypoint = createEntrypointNode({
      fileNodeId,
      row: astNode.startPosition.row + 1,
      column: astNode.startPosition.column,
      kind: "server-action",
      trigger: typeof name === "string" ? name : null,
      receiverName: null,
      library: "react",
      handlerName: typeof name === "string" ? name : null,
    });
    parsed.nodes.push(entrypoint);
    parsed.relationships.push(
      { from: fileNodeId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} },
      { from: entrypoint.id, to: functionNodeId, type: "ENTRYPOINT_HANDLED_BY", properties: {} },
    );
  }
}

// A directive prologue (the leading string statements of a program or a
// function body) that contains "use server".
function hasUseServer(block: SyntaxNode): boolean {
  for (const statement of block.namedChildren) {
    if (!statement || statement.type === "comment" || statement.type === "hash_bang_line") continue;
    const value = statement.type === "expression_statement" ? statement.namedChildren[0] : null;
    if (value?.type !== "string") return false;
    if (value.text.slice(1, -1) === "use server") return true;
  }
  return false;
}

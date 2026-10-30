import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { analyzeMemberCallExpression } from "../../languages/tree-sitter-utils.js";
import { createEntrypointNode } from "./entrypoint-graph.js";
import { indexFileFunctions, indexPassedToHandlers, stripStringQuotes } from "./file-index.js";

// Browser DOM semantics: event listeners become EntryPoints (kind
// `dom-event`, trigger = event name) and `customElements.define` becomes a
// web Component. Listeners count anywhere in a file, since most are added
// inside setup functions.

export function applyDomParseSemantics(
  fileNodeId: string,
  programNode: SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): void {
  const functionsByName = indexFileFunctions(fileNodeId, nodes, relationships);
  const functionIdsByPassedToCallId = indexPassedToHandlers(relationships);
  const classIdsByName = fileClassIds(fileNodeId, nodes, relationships);
  const added: { nodes: GraphNode[]; relationships: GraphRelationship[] } = { nodes: [], relationships: [] };

  for (const callExpr of callExpressions(programNode)) {
    const parts = analyzeMemberCallExpression(callExpr.childForFieldName("function")?.text);
    if (!parts?.receiver) continue;
    const args = callExpr.childForFieldName("arguments")?.namedChildren ?? [];

    if (parts.callee === "addEventListener") {
      const row = callExpr.startPosition.row + 1;
      const column = callExpr.startPosition.column;
      const handler = args[1];
      const handlerName = handler?.type === "identifier" ? handler.text : null;
      const entrypoint = createEntrypointNode({
        fileNodeId,
        row,
        column,
        kind: "dom-event",
        trigger: args[0]?.type === "string" ? stripStringQuotes(args[0].text) : null,
        receiverName: parts.receiver.split(".")[0] ?? null,
        library: "dom",
        handlerName,
      });
      added.nodes.push(entrypoint);
      added.relationships.push({ from: fileNodeId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} });

      // A named function of the file, or an inline one passed to a
      // module-level call (only those get a Function node of their own).
      const handlerId = handlerName
        ? functionsByName.get(handlerName)
        : functionIdsByPassedToCallId.get(`${fileNodeId}:modulecall:${row}:${column}:${parts.expression}`);
      if (handlerId) {
        added.relationships.push({ from: entrypoint.id, to: handlerId, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
      }
      continue;
    }

    if (parts.callee === "define" && (parts.receiver === "customElements" || parts.receiver === "window.customElements")) {
      if (args[0]?.type !== "string") continue;
      const tagName = stripStringQuotes(args[0].text);
      const className = args[1]?.type === "identifier" ? args[1].text : null;
      const line = callExpr.startPosition.row + 1;
      const component: GraphNode = {
        id: `${fileNodeId}:component:${line}:${tagName}`,
        label: "Component",
        properties: { name: className ?? tagName, framework: "web-components", kind: "web-component", tagName, line },
      };
      added.nodes.push(component);
      added.relationships.push({ from: fileNodeId, to: component.id, type: "DECLARES_COMPONENT", properties: {} });
      const classId = className ? classIdsByName.get(className) : undefined;
      if (classId) {
        added.relationships.push({ from: component.id, to: classId, type: "COMPONENT_DEFINED_BY", properties: {} });
      }
    }
  }

  nodes.push(...added.nodes);
  relationships.push(...added.relationships);
}

// `on*` attributes of an HTML page (`<button onclick="save()">`) are listeners
// too. The handler is the function the attribute calls first, when the page
// defines it.
export function applyDomAttributeSemantics(
  fileNodeId: string,
  documentNode: SyntaxNode,
  nodes: GraphNode[],
  relationships: GraphRelationship[],
): void {
  const functionsByName = indexFileFunctions(fileNodeId, nodes, relationships);
  const visit = (node: SyntaxNode) => {
    if (node.type === "start_tag" || node.type === "self_closing_tag") {
      const tagName = node.namedChildren.find((child) => child?.type === "tag_name")?.text.toLowerCase() ?? null;
      for (const attribute of node.namedChildren) {
        if (attribute?.type !== "attribute") continue;
        const name = attribute.namedChildren.find((child) => child?.type === "attribute_name")?.text.toLowerCase() ?? "";
        if (!/^on[a-z]+$/u.test(name)) continue;
        const valueNode = attribute.namedChildren.find((child) => child?.type === "attribute_value" || child?.type === "quoted_attribute_value");
        const value = valueNode?.type === "quoted_attribute_value"
          ? valueNode.namedChildren.find((child) => child?.type === "attribute_value")?.text ?? ""
          : valueNode?.text ?? "";
        if (value.trim() === "") continue;

        const handlerName = /^\s*([A-Za-z_$][\w$]*)\s*\(/u.exec(value)?.[1] ?? null;
        const entrypoint = createEntrypointNode({
          fileNodeId,
          row: attribute.startPosition.row + 1,
          column: attribute.startPosition.column,
          kind: "dom-event",
          trigger: name.slice(2),
          receiverName: tagName,
          library: "dom",
          handlerName,
        });
        nodes.push(entrypoint);
        relationships.push({ from: fileNodeId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} });
        const handlerId = handlerName ? functionsByName.get(handlerName) : undefined;
        if (handlerId) {
          relationships.push({ from: entrypoint.id, to: handlerId, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(documentNode);
}

function callExpressions(root: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression") calls.push(node);
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  visit(root);
  return calls;
}

function fileClassIds(fileNodeId: string, nodes: GraphNode[], relationships: GraphRelationship[]): Map<string, string> {
  const classIds = new Set(
    relationships.filter((rel) => rel.from === fileNodeId && rel.type === "DEFINES_CLASS").map((rel) => rel.to),
  );
  const byName = new Map<string, string>();
  for (const node of nodes) {
    if (node.label === "Class" && classIds.has(node.id) && typeof node.properties.name === "string" && !byName.has(node.properties.name)) {
      byName.set(node.properties.name, node.id);
    }
  }
  return byName;
}

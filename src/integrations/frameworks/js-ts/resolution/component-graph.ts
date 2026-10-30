import type { GraphNode, GraphRelationship } from "../../../../core/graph/model.js";
import type { IGraphContributor } from "../../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../../core/contracts/semantic-contributor.js";
import { resolveCall, resolveDeclaration } from "../../../../core/scan/resolution/call-targets.js";
import { createResolutionRelationshipIndex, indexImportNodesByFile } from "../../../../core/scan/resolution/indexes.js";
import { isHookCall, type PendingRender } from "../react.js";

// Cross-file component relationships:
// - RENDERS: the JSX a component renders (`<UserCard name={…} />`) to the
//   rendered Component, declared in the same file or imported by name or as the
//   default export, through barrels. `<CartContext.Provider>` renders the
//   context. `Component.pendingRenders` keeps the elements that stay
//   unresolved (library components such as `<Link>`).
// - USES_HOOK: a component's function or a custom hook (`use*`) to the hook
//   function its call resolves to; built-in hooks have no Function and are
//   only listed in `Component.hooks`.
// - USES_CONTEXT: such a function to the context its `useContext(Ctx)` /
//   `use(Ctx)` reads.
export const componentGraphContributor: ISemanticContributor = {
  contribute(graph) {
    addComponentRelationships(graph);
  },
};

export function addComponentRelationships(graph: IGraphContributor): void {
  const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
  const importNodesByFile = indexImportNodesByFile(graph.nodes, relationshipIndex.fileByImportId);
  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const fileByComponentId = new Map<string, string>();
  const componentsByFileAndName = new Map<string, Map<string, string[]>>();
  for (const rel of graph.relationships) {
    if (rel.type !== "DECLARES_COMPONENT") continue;
    const name = nodesById.get(rel.to)?.properties.name;
    if (typeof name !== "string") continue;
    fileByComponentId.set(rel.to, rel.from);
    addDeclaration(componentsByFileAndName, rel.from, name, rel.to);
  }
  if (fileByComponentId.size === 0) return;

  // `export default function App()` / `export default App`.
  for (const [fileId, byName] of componentsByFileAndName) {
    const defaultExport = nodesById.get(fileId)?.properties.defaultExport;
    const ids = typeof defaultExport === "string" ? byName.get(defaultExport) : undefined;
    if (ids && !byName.has("default")) byName.set("default", ids);
  }

  const contextsByFileAndName = new Map<string, Map<string, string[]>>();
  for (const [componentId, fileId] of fileByComponentId) {
    const component = nodesById.get(componentId)!;
    if (component.properties.kind === "context") addDeclaration(contextsByFileAndName, fileId, String(component.properties.name), componentId);
  }
  const resolveContext = (name: string, fileId: string) =>
    resolveDeclaration(name, fileId, contextsByFileAndName, importNodesByFile, relationshipIndex.resolvedFileByImportId);

  const added: GraphRelationship[] = [];
  for (const [componentId, fileId] of fileByComponentId) {
    const component = nodesById.get(componentId)!;
    const renders = parsePendingRenders(component.properties.pendingRenders);
    if (renders.length === 0) continue;

    const unresolved: PendingRender[] = [];
    for (const render of renders) {
      const dot = render.name.lastIndexOf(".");
      const member = render.name.slice(dot + 1);
      const target = dot === -1
        ? resolveDeclaration(render.name, fileId, componentsByFileAndName, importNodesByFile, relationshipIndex.resolvedFileByImportId)
        : (member === "Provider" || member === "Consumer") && !render.name.slice(0, dot).includes(".")
          ? resolveContext(render.name.slice(0, dot), fileId)
          : resolveCall(member, render.name.slice(0, dot), fileId, componentsByFileAndName, importNodesByFile, relationshipIndex.resolvedFileByImportId);
      if (target) {
        added.push({ from: componentId, to: target, type: "RENDERS", properties: { props: render.props.join(","), line: render.line } });
      } else {
        unresolved.push(render);
      }
    }
    component.properties.pendingRenders = unresolved.length > 0 ? JSON.stringify(unresolved) : null;
  }

  // Functions that may call hooks: those defining a component, and custom hooks.
  const componentFunctionIds = new Set(
    graph.relationships.filter((rel) => rel.type === "COMPONENT_DEFINED_BY_FUNCTION").map((rel) => rel.to),
  );
  const resolvedByCallId = new Map<string, string>();
  for (const rel of graph.relationships) {
    if (rel.type === "CALL_RESOLVES_TO") resolvedByCallId.set(rel.from, rel.to);
  }
  for (const [callId, functionId] of relationshipIndex.callerFunctionByCallId) {
    const call = nodesById.get(callId);
    if (!call || !isHookCall(call)) continue;
    const caller = nodesById.get(functionId);
    const callerName = caller?.properties.name;
    if (!componentFunctionIds.has(functionId) && !(typeof callerName === "string" && /^use[A-Z0-9]/u.test(callerName))) continue;
    const line = Number(call.properties.line);

    const callee = String(call.properties.callee);
    if (callee === "useContext" || callee === "use") {
      const fileId = relationshipIndex.fileByFunctionId.get(functionId);
      const contextName = parseArgs(call.properties.args)[0];
      const contextId = fileId && contextName ? resolveContext(contextName, fileId) : null;
      if (contextId) added.push({ from: functionId, to: contextId, type: "USES_CONTEXT", properties: { line } });
      continue;
    }
    const hookId = resolvedByCallId.get(callId);
    if (hookId) added.push({ from: functionId, to: hookId, type: "USES_HOOK", properties: { line } });
  }
  for (const rel of added) graph.addRelationship(rel);
}

function parseArgs(value: GraphNode["properties"][string]): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function addDeclaration(index: Map<string, Map<string, string[]>>, fileId: string, name: string, id: string): void {
  let byName = index.get(fileId);
  if (!byName) index.set(fileId, byName = new Map());
  byName.set(name, [...(byName.get(name) ?? []), id]);
}

function parsePendingRenders(value: GraphNode["properties"][string]): PendingRender[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as PendingRender[] : [];
  } catch {
    return [];
  }
}

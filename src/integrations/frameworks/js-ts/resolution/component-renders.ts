import type { GraphNode, GraphRelationship } from "../../../../core/graph/model.js";
import type { IGraphContributor } from "../../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../../core/contracts/semantic-contributor.js";
import { resolveCall, resolveDeclaration } from "../../../../core/scan/resolution/call-targets.js";
import { createResolutionRelationshipIndex, indexImportNodesByFile } from "../../../../core/scan/resolution/indexes.js";
import type { PendingRender } from "../react.js";

// Links the JSX a component renders (`<UserCard name={…} />`) to the rendered
// Component: declared in the same file, or imported by name or as the default
// export, through barrels. `Component.pendingRenders` keeps the elements that
// stay unresolved (library components such as `<Link>`).
export const componentRendersContributor: ISemanticContributor = {
  contribute(graph) {
    addComponentRenderRelationships(graph);
  },
};

export function addComponentRenderRelationships(graph: IGraphContributor): void {
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

  const added: GraphRelationship[] = [];
  for (const [componentId, fileId] of fileByComponentId) {
    const component = nodesById.get(componentId)!;
    const renders = parsePendingRenders(component.properties.pendingRenders);
    if (renders.length === 0) continue;

    const unresolved: PendingRender[] = [];
    for (const render of renders) {
      const dot = render.name.lastIndexOf(".");
      const target = dot === -1
        ? resolveDeclaration(render.name, fileId, componentsByFileAndName, importNodesByFile, relationshipIndex.resolvedFileByImportId)
        : resolveCall(render.name.slice(dot + 1), render.name.slice(0, dot), fileId, componentsByFileAndName, importNodesByFile, relationshipIndex.resolvedFileByImportId);
      if (target) {
        added.push({ from: componentId, to: target, type: "RENDERS", properties: { props: render.props.join(","), line: render.line } });
      } else {
        unresolved.push(render);
      }
    }
    component.properties.pendingRenders = unresolved.length > 0 ? JSON.stringify(unresolved) : null;
  }
  for (const rel of added) graph.addRelationship(rel);
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

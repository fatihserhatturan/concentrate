import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";

// Where each Java Function sits: its owning type (a Class, or an Interface for interface
// methods) and the file that declares the type. The parser links every type, nested ones included,
// straight from its File (`File -DEFINES_CLASS-> Outer.Inner`), so no walk up to the top-level type is needed.
export type JavaMethod = { node: GraphNode; owner: GraphNode; fileId: string };

export function javaMethods(graph: IGraphContributor): JavaMethod[] {
  const fileOfType = new Map<string, string>();
  for (const type of ["DEFINES_CLASS", "DEFINES_INTERFACE"] as const) {
    for (const rel of graph.relationshipsOfType(type)) fileOfType.set(rel.to, rel.from);
  }
  const methods: JavaMethod[] = [];
  for (const type of ["DEFINES_METHOD", "DEFINES_INTERFACE_METHOD"] as const) {
    // DEFINES_INTERFACE_METHOD comes from the Java schema extension, not the static type.
    for (const rel of graph.relationshipsOfType(type as GraphRelationship["type"])) {
      const owner = graph.node(rel.from);
      const node = graph.node(rel.to);
      const fileId = fileOfType.get(rel.from);
      if (!owner || !node || !fileId || graph.node(fileId)?.properties.language !== "java") continue;
      methods.push({ node, owner, fileId });
    }
  }
  return methods;
}

import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";

// A C# Function with the File that really declares it. A `partial` type has one shared Class node linked from every
// declaring file, so the file comes from the member's own id (`file:<path>:function:<line>:<name>`), not from the owner.
export type CSharpMethod = { node: GraphNode; owner: GraphNode; fileId: string };

const FILE_OF_MEMBER = /^(file:.+?):(?:function|field|class|interface):\d+:/u;

export function csharpMethods(graph: IGraphContributor): CSharpMethod[] {
  const methods: CSharpMethod[] = [];
  for (const type of ["DEFINES_METHOD", "DEFINES_INTERFACE_METHOD"] as const) {
    for (const rel of graph.relationshipsOfType(type as GraphRelationship["type"])) {
      const owner = graph.node(rel.from);
      const node: GraphNode | undefined = graph.node(rel.to);
      const fileId = node ? FILE_OF_MEMBER.exec(node.id)?.[1] : undefined;
      if (!owner || !node || !fileId || graph.node(fileId)?.properties.language !== "csharp") continue;
      methods.push({ node, owner, fileId });
    }
  }
  return methods;
}

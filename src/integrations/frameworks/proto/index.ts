import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";

// Protocol Buffers in the graph: the request and response message of each rpc
// (`RPC_REQUEST`, `RPC_RESPONSE`). A type is resolved as protobuf does, from
// the rpc's own package outwards (`a.b.Req`, `a.Req`, `Req`), or as written
// when it is qualified (`other.v1.Req`, `.other.v1.Req`). A type no scanned
// file declares (`google.protobuf.Empty`) is not linked. The Go code that
// serves an rpc is linked by frameworks/go/grpc.ts.
export const protoContributor: ISemanticContributor = {
  contribute(graph) {
    const messages = new Map<string, GraphNode>();
    const rpcs: GraphNode[] = [];
    for (const node of graph.nodes) {
      if (node.label === "Message") {
        const fullName = String(node.properties.fullName);
        if (!messages.has(fullName)) messages.set(fullName, node);
      } else if (node.label === "Rpc") {
        rpcs.push(node);
      }
    }
    if (rpcs.length === 0) return;
    const resolve = (type: string, pkg: string | null): GraphNode | undefined => {
      if (type.startsWith(".")) return messages.get(type.slice(1));
      const scopes = pkg ? pkg.split(".") : [];
      for (let depth = scopes.length; depth >= 0; depth -= 1) {
        const found = messages.get([...scopes.slice(0, depth), type].join("."));
        if (found) return found;
      }
      return undefined;
    };
    for (const rpc of rpcs) {
      const pkg = typeof rpc.properties.package === "string" ? rpc.properties.package : null;
      for (const [property, relationship] of [["request", "RPC_REQUEST"], ["response", "RPC_RESPONSE"]] as const) {
        const message = resolve(String(rpc.properties[property]), pkg);
        if (message) graph.addRelationship({ from: rpc.id, to: message.id, type: relationship, properties: {} });
      }
    }
  },
};

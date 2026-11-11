import type { GraphNode, ParsedSourceFile } from "../../../core/graph/model.js";
import { readProto } from "./proto.js";

// The graph of a `.proto` file: a `Service` per service with an `Rpc` per rpc
// (`HAS_RPC`), a `Message` per top-level message, each declared by the file,
// and an `Import` per `import "x.proto"`. The request and response types
// (`RPC_REQUEST`, `RPC_RESPONSE`) and the Go code that serves an rpc are
// linked once every file is read (frameworks/proto, frameworks/go/grpc).
export function protoGraph(fileNodeId: string, source: string, parsed: ParsedSourceFile): void {
  const read = readProto(source);
  const pkg = read.package;
  const qualify = (name: string) => (pkg ? `${pkg}.${name}` : name);
  const declare = (node: GraphNode, type: "DECLARES_SERVICE" | "DECLARES_MESSAGE") => {
    parsed.nodes.push(node);
    parsed.relationships.push({ from: fileNodeId, to: node.id, type, properties: {} });
  };
  for (const message of read.messages) {
    declare({
      id: `${fileNodeId}:message:${message.name}`,
      label: "Message",
      properties: { name: message.name, package: pkg, fullName: qualify(message.name), line: message.line },
    }, "DECLARES_MESSAGE");
  }
  for (const service of read.services) {
    const serviceNode: GraphNode = {
      id: `${fileNodeId}:service:${service.name}`,
      label: "Service",
      properties: { name: service.name, package: pkg, fullName: qualify(service.name), line: service.line },
    };
    declare(serviceNode, "DECLARES_SERVICE");
    for (const rpc of service.rpcs) {
      const rpcNode: GraphNode = {
        id: `${fileNodeId}:rpc:${service.name}.${rpc.name}`,
        label: "Rpc",
        properties: {
          name: rpc.name,
          service: qualify(service.name),
          package: pkg,
          request: rpc.request,
          response: rpc.response,
          clientStreaming: rpc.clientStreaming,
          serverStreaming: rpc.serverStreaming,
          line: rpc.line,
        },
      };
      parsed.nodes.push(rpcNode);
      parsed.relationships.push({ from: serviceNode.id, to: rpcNode.id, type: "HAS_RPC", properties: {} });
    }
  }
  for (const entry of read.imports) {
    const id = `${fileNodeId}:import:${entry.line}:${entry.path}`;
    if (parsed.nodes.some((node) => node.id === id)) continue;
    parsed.nodes.push({
      id,
      label: "Import",
      properties: {
        source: entry.path,
        specifier: `import ${entry.modifier ? `${entry.modifier} ` : ""}"${entry.path}"`,
        line: entry.line,
        isReExport: entry.modifier === "public",
        isWildcard: false,
        isDynamic: false,
        isCjs: false,
        isTypeOnly: false,
        bindings: null,
      },
    });
    parsed.relationships.push({ from: fileNodeId, to: id, type: "IMPORTS", properties: {} });
  }
}

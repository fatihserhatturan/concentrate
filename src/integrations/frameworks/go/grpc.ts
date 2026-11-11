import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GoParsePlugin } from "../../languages/go/parser.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createGoCallIndex } from "../../../core/scan/resolution/go-calls.js";
import { importedPackages } from "./routes.js";
import { descendantsOf } from "./scope.js";

// gRPC calls between services of the scan. The client protoc-gen-go-grpc
// writes calls `c.cc.Invoke(ctx, "/user.v1.User/Save", …)` (`NewStream` for
// a stream); the server side of the same file declares the service
// (`grpc.ServiceDesc{ServiceName: "user.v1.User", HandlerType:
// (*UserServer)(nil), Methods: …}`). Once every file is parsed, the Invoke
// call resolves (CALL_RESOLVES_TO, `via: "grpc"`) to the method of each
// struct implementing the server interface, the `Unimplemented…Server`
// stub aside, so callers, call chains and impact cross from one service
// into the other.

const GRPC = "google.golang.org/grpc";

type GrpcService = { service: string; handlerType: string; methods: string[] };

export const goGrpcPlugin: GoParsePlugin = ({ fileNodeId, root, nodes, functions }) => {
  const grpc = importedPackages(root).get(GRPC);
  if (!grpc) return;
  const constants = new Map<string, string>();
  for (const node of nodes) {
    if (node.label === "Variable" && typeof node.properties.stringValue === "string") constants.set(String(node.properties.name), node.properties.stringValue);
  }
  const stringValue = (node: SyntaxNode | undefined): string | null => {
    if (!node) return null;
    if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") return node.text.slice(1, -1);
    if (node.type === "identifier") return constants.get(node.text) ?? null;
    return null;
  };
  const callsByPosition = new Map(nodes.filter((node) => node.label === "Call").map((node) => [`${String(node.properties.line)}:${String(node.properties.columnNumber)}`, node]));

  // Client calls: the method name of each `Invoke` / `NewStream`.
  for (const fn of functions) {
    for (const call of descendantsOf(fn.syntax, "call_expression")) {
      const callee = call.childForFieldName("function");
      const method = callee?.type === "selector_expression" ? callee.childForFieldName("field")?.text : undefined;
      if (method !== "Invoke" && method !== "NewStream") continue;
      const args = call.childForFieldName("arguments")?.namedChildren ?? [];
      const fullMethod = stringValue(args[method === "Invoke" ? 1 : 2]);
      if (!fullMethod || !/^\/[\w.]+\/\w+$/u.test(fullMethod)) continue;
      const node = callsByPosition.get(`${call.startPosition.row + 1}:${call.startPosition.column}`);
      if (node) node.properties.grpcMethod = fullMethod;
    }
  }

  // Server side: the services the file declares.
  const services: GrpcService[] = [];
  for (const literal of descendantsOf(root, "composite_literal")) {
    if (literal.childForFieldName("type")?.text !== `${grpc}.ServiceDesc`) continue;
    const fields = keyedFields(literal);
    const service = stringValue(fields.get("ServiceName"));
    const handlerType = /\(\s*\*\s*(\w+)\s*\)/u.exec(fields.get("HandlerType")?.text ?? "")?.[1];
    if (!service || !handlerType) continue;
    const methods: string[] = [];
    for (const [list, key] of [[fields.get("Methods"), "MethodName"], [fields.get("Streams"), "StreamName"]] as const) {
      // `[]grpc.MethodDesc{{MethodName: "Save", …}, …}`: the elements' type is elided.
      for (const element of list ? descendantsOf(list, "literal_value") : []) {
        const name = stringValue(keyedFields(element).get(key));
        if (name) methods.push(name);
      }
    }
    services.push({ service, handlerType, methods });
  }
  const file = nodes.find((node) => node.id === fileNodeId);
  if (file && services.length > 0) file.properties.goGrpcServices = JSON.stringify(services);
};

export const goGrpcContributor: ISemanticContributor = {
  contribute(graph) {
    const files = graph.nodes.filter((node) => node.label === "File" && typeof node.properties.goGrpcServices === "string");
    const calls = graph.nodes.filter((node) => node.label === "Call" && typeof node.properties.grpcMethod === "string");
    const rpcs = graph.nodes.filter((node) => node.label === "Rpc");
    if (files.length === 0 || (calls.length === 0 && rpcs.length === 0)) {
      for (const node of [...files, ...calls]) {
        delete node.properties.goGrpcServices;
        delete node.properties.grpcMethod;
      }
      return;
    }
    const index = createGoCallIndex(graph, createResolutionRelationshipIndex(graph.relationships));
    const targets = new Map<string, string[]>();
    // service name → the generated server interface, and the implementations of each method
    const served = new Map<string, { interfaceId: string; methods: Map<string, string[]> }>();
    for (const file of files) {
      const services = JSON.parse(String(file.properties.goGrpcServices)) as GrpcService[];
      delete file.properties.goGrpcServices;
      const pkg = index.packageByFile.get(file.id);
      if (pkg === undefined) continue;
      for (const { service, handlerType, methods } of services) {
        const iface = index.interfacesByPackage.get(pkg)?.get(handlerType);
        if (!iface) continue;
        const implementers = (index.implementersByInterface.get(iface.node.id) ?? []).filter((type) => !type.anonymous && !type.name.startsWith("Unimplemented"));
        const servedMethods = new Map<string, string[]>();
        served.set(service, { interfaceId: iface.node.id, methods: servedMethods });
        for (const method of methods) {
          const ids = implementers
            .map((type) => index.methodsByPackage.get(type.pkg)?.get(`${type.name}.${method}`))
            .filter((id): id is string => id !== undefined);
          servedMethods.set(method, [...new Set(ids)].sort());
          if (ids.length > 0) targets.set(`/${service}/${method}`, [...new Set(ids)].sort());
        }
      }
    }
    const relationships: GraphRelationship[] = [];
    // `.proto` rpcs: the generated server interface of the service (when its
    // ServiceDesc lists the method) and the methods that implement it.
    for (const rpc of rpcs) {
      const entry = served.get(String(rpc.properties.service));
      const implementations = entry?.methods.get(String(rpc.properties.name));
      if (!entry || !implementations) continue;
      relationships.push({ from: rpc.id, to: entry.interfaceId, type: "RPC_SERVED_BY", properties: { method: String(rpc.properties.name) } });
      for (const to of implementations) relationships.push({ from: rpc.id, to, type: "RPC_IMPLEMENTED_BY", properties: {} });
    }
    for (const call of calls) {
      const fullMethod = String(call.properties.grpcMethod);
      delete call.properties.grpcMethod;
      for (const to of targets.get(fullMethod) ?? []) {
        relationships.push({ from: call.id, to, type: "CALL_RESOLVES_TO", properties: { via: "grpc" } });
      }
    }
    graph.addRelationships(relationships);
  },
};

// `Key: value` elements of a composite literal (or of its elided `{…}`).
function keyedFields(literal: SyntaxNode): Map<string, SyntaxNode> {
  const fields = new Map<string, SyntaxNode>();
  const body = literal.type === "literal_value" ? literal : literal.childForFieldName("body");
  for (const element of body?.namedChildren ?? []) {
    if (element.type !== "keyed_element") continue;
    const [key, value] = element.namedChildren;
    const name = key?.type === "literal_element" ? key.namedChildren[0]?.text : key?.text;
    const inner = value?.type === "literal_element" ? value.namedChildren[0] : value;
    if (name && inner) fields.set(name, inner);
  }
  return fields;
}

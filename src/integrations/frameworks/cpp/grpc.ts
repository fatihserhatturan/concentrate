import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { CppParsePlugin } from "../../languages/cpp/parser.js";
import { readCppSource } from "./scan.js";

// gRPC C++. The server side is a class deriving from the generated
// `X::Service` (or `X::CallbackService`): every method it implements is an
// EntryPoint (kind `grpc`, trigger `X/Method`) handled by the method. The
// client side is a call on the generated stub (`stub_->Method(&ctx, req,
// &reply)`, also `AsyncMethod` / `PrepareAsyncMethod`), a variable declared
// `X::Stub` or made by `X::NewStub(channel)`; once every file is parsed the
// call resolves (CALL_RESOLVES_TO, `via: "grpc"`) to the method of each class
// implementing the service, so callers, call chains and impact cross from one
// service into the other. A stub declared in a header and called in a source
// file is found by its variable name when only one service uses it. A
// `.proto` rpc gets RPC_IMPLEMENTED_BY to the implementing methods.

type Stub = { variable: string; service: string };

export const cppGrpcPlugin: CppParsePlugin = ({ fileNodeId, source: written, nodes }) => {
  if (!/\b(?:Stub|NewStub)\b/u.test(written)) return;
  const source = readCppSource(written);
  const stubs = new Map<string, string>();
  for (const match of source.code.matchAll(/\b(?:\w+::)*(\w+)::Stub\b[\s>*&]*(\w+)\s*[;=({,)]/gu)) stubs.set(match[2]!, match[1]!);
  for (const match of source.code.matchAll(/\b(\w+)\s*(?:=|\(|\{)\s*(?:std::)?(?:move\s*\(\s*)?(?:\w+::)*(\w+)::NewStub\s*\(/gu)) stubs.set(match[1]!, match[2]!);
  const file = nodes.find((node) => node.id === fileNodeId);
  if (file && stubs.size > 0) file.properties.cppGrpcStubs = JSON.stringify([...stubs].map(([variable, service]) => ({ variable, service } satisfies Stub)));

  for (const node of nodes) {
    if (node.label !== "Call" || typeof node.properties.receiver !== "string") continue;
    const callee = String(node.properties.callee);
    if (!/^[A-Z]/u.test(callee)) continue;
    const variable = node.properties.receiver.split(".").at(-1)!;
    const service = stubs.get(variable);
    if (service === undefined && !/stub/iu.test(variable)) continue;
    node.properties.cppGrpcMethod = callee;
    node.properties.cppGrpcStub = variable;
    if (service !== undefined) node.properties.cppGrpcService = service;
  }
};

type Implementation = { service: string; className: string; methods: Map<string, string> };

export const cppGrpcContributor: ISemanticContributor = {
  contribute(graph) {
    const calls = graph.nodes.filter((node) => node.label === "Call" && typeof node.properties.cppGrpcMethod === "string");
    const files = graph.nodes.filter((node) => node.label === "File" && typeof node.properties.cppGrpcStubs === "string");
    const strip = () => {
      for (const node of [...calls, ...files]) {
        delete node.properties.cppGrpcMethod;
        delete node.properties.cppGrpcStub;
        delete node.properties.cppGrpcService;
        delete node.properties.cppGrpcStubs;
      }
    };
    const serviceClasses: Array<{ node: GraphNode; service: string }> = [];
    for (const node of graph.nodes) {
      if (node.label !== "Class" || typeof node.properties.bases !== "string" || !node.properties.bases.includes("Service")) continue;
      for (const base of JSON.parse(node.properties.bases) as Array<{ name: string }>) {
        const match = /(?:^|::)(\w+)::(?:Service|CallbackService)$/u.exec(base.name);
        if (match) serviceClasses.push({ node, service: match[1]! });
      }
    }
    if (serviceClasses.length === 0) {
      strip();
      return;
    }

    const methodsByClass = new Map<string, GraphNode[]>();
    for (const node of graph.nodes) {
      if (node.label !== "Function" || typeof node.properties.className !== "string" || node.properties.kind !== "method") continue;
      methodsByClass.set(node.properties.className, [...methodsByClass.get(node.properties.className) ?? [], node]);
    }
    const fileByClass = new Map<string, string>();
    for (const relationship of graph.relationships) {
      if (relationship.type === "DEFINES_CLASS") fileByClass.set(relationship.to, relationship.from);
    }

    const implementations: Implementation[] = [];
    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    for (const { node, service } of serviceClasses) {
      const className = String(node.properties.name);
      const byName = new Map<string, GraphNode[]>();
      // Classes of one name in several files (examples, tests) keep to their own file and its header or source twin.
      const classFile = fileByClass.get(node.id) ?? "";
      const stem = (fileId: string) => fileId.replace(/\.[^./]+$/u, "");
      const own = (methodsByClass.get(className) ?? []).filter((method) => {
        const file = method.id.split(":function:")[0]!;
        return file === classFile || stem(file) === stem(classFile);
      });
      for (const method of own) {
        if (!/^[A-Z]/u.test(String(method.properties.name))) continue;
        const parameters = String(method.properties.parameters ?? "");
        if (method.properties.isOverride !== true && !parameters.includes("ServerContext")) continue;
        byName.set(String(method.properties.name), [...byName.get(String(method.properties.name)) ?? [], method]);
      }
      const methods = new Map<string, string>();
      for (const [name, candidates] of byName) {
        // The definition over the declaration.
        const handler = candidates.find((candidate) => candidate.properties.isDeclaration !== true) ?? candidates[0]!;
        methods.set(name, handler.id);
        const fileId = handler.id.split(":function:")[0] ?? fileByClass.get(node.id) ?? "";
        const line = Number(handler.properties.line);
        const entrypoint: GraphNode = {
          id: `${fileId}:entrypoint:${line}:grpc:${service}/${className}.${name}`,
          label: "EntryPoint",
          properties: { kind: "grpc", trigger: `${service}/${name}`, receiverName: className, library: "grpc", line, handlerName: name },
        };
        nodes.push(entrypoint);
        relationships.push(
          { from: fileId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} },
          { from: entrypoint.id, to: handler.id, type: "ENTRYPOINT_HANDLED_BY", properties: {} },
        );
      }
      implementations.push({ service, className, methods });
    }

    // Stub variables by name across files (one service only).
    const services = new Map<string, Set<string>>();
    for (const file of files) {
      for (const stub of JSON.parse(String(file.properties.cppGrpcStubs)) as Stub[]) services.set(stub.variable, (services.get(stub.variable) ?? new Set()).add(stub.service));
    }
    const targetsOf = (service: string, method: string): string[] => {
      const names = [method, method.replace(/^PrepareAsync/u, ""), method.replace(/^Async/u, "")];
      const ids = new Set<string>();
      for (const implementation of implementations) {
        if (implementation.service !== service) continue;
        const name = names.find((candidate) => implementation.methods.has(candidate));
        if (name) ids.add(implementation.methods.get(name)!);
      }
      return [...ids].sort();
    };
    for (const call of calls) {
      const service = typeof call.properties.cppGrpcService === "string"
        ? call.properties.cppGrpcService
        : (() => {
          const found = services.get(String(call.properties.cppGrpcStub));
          return found?.size === 1 ? [...found][0]! : undefined;
        })();
      if (service === undefined) continue;
      for (const to of targetsOf(service, String(call.properties.cppGrpcMethod))) {
        relationships.push({ from: call.id, to, type: "CALL_RESOLVES_TO", properties: { via: "grpc" } });
      }
    }
    for (const rpc of graph.nodes) {
      if (rpc.label !== "Rpc") continue;
      const service = String(rpc.properties.service).split(".").at(-1)!;
      for (const implementation of implementations) {
        const id = implementation.service === service ? implementation.methods.get(String(rpc.properties.name)) : undefined;
        if (id) relationships.push({ from: rpc.id, to: id, type: "RPC_IMPLEMENTED_BY", properties: {} });
      }
    }
    strip();
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

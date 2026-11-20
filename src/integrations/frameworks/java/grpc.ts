import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";
import { addJavaEntryPoint } from "./annotations.js";
import { javaMethods } from "./shared.js";

// gRPC Java between services of the scan, as frameworks/go/grpc.ts does for Go.
//
// Server side: a class extending the generated `XGrpc.XImplBase` (or `XImplBase` imported, or
// implementing `XGrpc.AsyncService`) serves the service X. Each public instance method of it with a
// gRPC signature — `(Req, StreamObserver<Resp>)`, or `StreamObserver<Resp> m(StreamObserver<Resp>)`
// for client streams and bidi — is an EntryPoint (kind `grpc`, library `grpc-java`, trigger
// `X/method`). When the generated class is in the scan too, the method must also be one the
// generated base declares (a helper with the same shape is not an rpc).
//
// Client side: a call on a receiver typed `XGrpc.XBlockingStub`, `XStub`, `XFutureStub` (a local,
// parameter or field of the calling class or its enclosing classes, `this.field`), or made by
// `XGrpc.newBlockingStub(channel)` / `newStub` / `newFutureStub` (directly, through `.withX(…)`
// calls, or held by a `var`) resolves (CALL_RESOLVES_TO, `via: "grpc"`) to the method of each class
// serving X that has the called name; several implementations are all linked, as in Go. A `.proto`
// rpc gets RPC_IMPLEMENTED_BY to those methods.
//
// Never guessed: a receiver whose type is unknown, a stub field of a superclass, a service name
// shared by two protos in different packages (they are not told apart: both link) and an
// intermediate base class between the implementation and `XImplBase` stay as they are.

const STUB_FACTORY = /^new(?:Blocking|Future|BlockingV2)?Stub$/u;

const isComment = (node: SyntaxNode) => node.type.endsWith("comment");

// `XGrpc.newBlockingStub(ch).withDeadline(...)`: the call chain with its `.withX(…)` calls peeled off.
function peelWith(node: SyntaxNode): SyntaxNode {
  let current = node;
  while (current.type === "method_invocation" && /^with[A-Z]/u.test(current.childForFieldName("name")?.text ?? "")) {
    const object = current.childForFieldName("object");
    if (!object) break;
    current = object;
  }
  return current;
}

// The service of `XGrpc.newBlockingStub(…)`, null for any other expression.
function factoryService(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  const call = peelWith(node);
  if (call.type !== "method_invocation" || !STUB_FACTORY.test(call.childForFieldName("name")?.text ?? "")) return null;
  const owner = call.childForFieldName("object")?.text.replace(/\s+/gu, "").split(".").at(-1) ?? "";
  return /^\w+Grpc$/u.test(owner) ? owner.slice(0, -"Grpc".length) : null;
}

type StubInfo = { locals: Record<string, string>; calls: Record<string, { service?: string; base?: string }> };

// What only the syntax tells: `var stub = XGrpc.newBlockingStub(channel);` (the graph keeps no type for a
// `var`), and calls on a stub made in place or through `.withX(…)` (`XGrpc.newBlockingStub(ch).m(req)`,
// `stub.withDeadlineAfter(1, SECONDS).m(req)`), keyed by the call's position.
export const javaGrpcPlugin: JavaParsePlugin = ({ root, functions }) => {
  if (!root.text.includes("Grpc.new") && !/\.with[A-Z]/u.test(root.text)) return;
  for (const { syntax, node } of functions) {
    const found = new Map<string, string | null>();
    const calls: StubInfo["calls"] = {};
    const stack: SyntaxNode[] = [...syntax.namedChildren];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.type.endsWith("_declaration") && current.type !== "local_variable_declaration") continue;
      if (current.type === "class_body") continue;
      if (current.type === "local_variable_declaration" && current.childForFieldName("type")?.text === "var") {
        for (const declarator of current.childrenForFieldName("declarator")) {
          const name = declarator.childForFieldName("name")?.text;
          if (!name) continue;
          const service = factoryService(declarator.childForFieldName("value"));
          // A name declared twice in the method is not told apart.
          found.set(name, found.has(name) ? null : service);
        }
      }
      if (current.type === "method_invocation") {
        const object = current.childForFieldName("object");
        const service = factoryService(object);
        const peeled = object ? peelWith(object) : null;
        const key = `${current.startPosition.row + 1}:${current.startPosition.column}`;
        if (service) calls[key] = { service };
        else if (object && peeled && peeled !== object && (peeled.type === "identifier" || (peeled.type === "field_access" && peeled.text.replace(/\s+/gu, "").startsWith("this.")))) calls[key] = { base: peeled.text.replace(/\s+/gu, "") };
      }
      stack.push(...current.namedChildren.filter((child) => !isComment(child)));
    }
    const locals: StubInfo["locals"] = {};
    for (const [name, service] of found) if (service) locals[name] = service;
    if (Object.keys(locals).length > 0 || Object.keys(calls).length > 0) node.properties.javaGrpcStubs = JSON.stringify({ locals, calls } satisfies StubInfo);
  }
};

type Parameter = { type?: string };
const parametersOf = (fn: GraphNode): Parameter[] => {
  try {
    const parsed: unknown = JSON.parse(String(fn.properties.parameters ?? "[]"));
    return Array.isArray(parsed) ? (parsed as Parameter[]) : [];
  } catch {
    return [];
  }
};
const isObserver = (type: string | null | undefined): boolean => /^(?:[\w.]+\.)?StreamObserver\b/u.test((type ?? "").replace(/\s+/gu, ""));

// `void m(Req, StreamObserver<Resp>)` or `StreamObserver<Resp> m(StreamObserver<Resp>)`.
function hasGrpcSignature(fn: GraphNode): boolean {
  if (fn.properties.kind !== "method" || fn.properties.isStatic === true || fn.properties.visibility !== "public") return false;
  const parameters = parametersOf(fn);
  if (parameters.length === 2) return isObserver(parameters[1]!.type);
  return parameters.length === 1 && isObserver(parameters[0]!.type) && isObserver(String(fn.properties.returnType ?? ""));
}

function serviceNamesOf(types: readonly string[], imports: { single: string[]; wildcard: string[] }): string[] {
  const services = new Set<string>();
  for (const written of types) {
    const parts = written.split(".");
    const last = parts.at(-1)!;
    const holder = parts.at(-2);
    const implBase = /^(\w+)ImplBase$/u.exec(last)?.[1];
    if (implBase) {
      // `XGrpc.XImplBase`, or a bare `XImplBase` imported from `XGrpc` (by name, or by a wildcard of the class).
      if (holder !== undefined ? holder === `${implBase}Grpc` : imports.single.some((source) => source.endsWith(`.${implBase}Grpc.${last}`)) || imports.wildcard.some((source) => source === `${implBase}Grpc` || source.endsWith(`.${implBase}Grpc`))) services.add(implBase);
    } else if (last === "AsyncService") {
      const grpc = holder ?? imports.single.find((source) => source.endsWith("Grpc.AsyncService"))?.split(".").at(-2);
      if (grpc && /^\w+Grpc$/u.test(grpc)) services.add(grpc.slice(0, -"Grpc".length));
    }
  }
  return [...services];
}

const lowerFirst = (name: string): string => name.charAt(0).toLowerCase() + name.slice(1);

export const javaGrpcContributor: ISemanticContributor = {
  id: "java.grpc",
  contribute(graph) {
    const stubFunctions = graph.nodesWithLabel("Function").filter((node) => typeof node.properties.javaGrpcStubs === "string");
    const stubInfo = new Map<string, StubInfo>();
    for (const fn of stubFunctions) {
      stubInfo.set(fn.id, JSON.parse(String(fn.properties.javaGrpcStubs)) as StubInfo);
      delete fn.properties.javaGrpcStubs;
    }

    const methods = javaMethods(graph);
    const methodsByOwner = new Map<string, GraphNode[]>();
    const ownerOf = new Map<string, GraphNode>();
    const fileOfFunction = new Map<string, string>();
    for (const method of methods) {
      ownerOf.set(method.node.id, method.owner);
      fileOfFunction.set(method.node.id, method.fileId);
      const list = methodsByOwner.get(method.owner.id);
      if (list) list.push(method.node);
      else methodsByOwner.set(method.owner.id, [method.node]);
    }
    const importsByFile = new Map<string, { single: string[]; wildcard: string[] }>();
    for (const rel of graph.relationshipsOfType("IMPORTS")) {
      const properties = graph.node(rel.to)?.properties;
      if (!properties || properties.isStatic === true || typeof properties.source !== "string") continue;
      let imports = importsByFile.get(rel.from);
      if (!imports) importsByFile.set(rel.from, imports = { single: [], wildcard: [] });
      (properties.isWildcard === true ? imports.wildcard : imports.single).push(properties.source);
    }
    const fileOfClass = new Map<string, string>();
    for (const rel of graph.relationshipsOfType("DEFINES_CLASS")) fileOfClass.set(rel.to, rel.from);

    // The rpcs the generated base declares, when it is in the scan: service → method names.
    const declared = new Map<string, Set<string>>();
    // Newer generated code declares them on `XGrpc.AsyncService` (default methods), older on `XImplBase`.
    const fileOfInterface = new Map<string, string>();
    for (const rel of graph.relationshipsOfType("DEFINES_INTERFACE")) fileOfInterface.set(rel.to, rel.from);
    for (const type of [...graph.nodesWithLabel("Class"), ...graph.nodesWithLabel("Interface")]) {
      const qualified = String(type.properties.qualifiedName ?? "");
      const match = /(?:^|\.)(\w+)Grpc\.(?:\1ImplBase|AsyncService)$/u.exec(qualified);
      const fileId = fileOfClass.get(type.id) ?? fileOfInterface.get(type.id);
      if (!match || !fileId || graph.node(fileId)?.properties.language !== "java") continue;
      const names = declared.get(match[1]!) ?? new Set<string>();
      for (const fn of methodsByOwner.get(type.id) ?? []) if (hasGrpcSignature(fn)) names.add(String(fn.properties.name));
      declared.set(match[1]!, names);
    }

    // Serving classes: service → method name → handler functions.
    const served = new Map<string, Map<string, GraphNode[]>>();
    const entrypoints: Array<{ fileId: string; service: string; fn: GraphNode }> = [];
    for (const cls of graph.nodesWithLabel("Class")) {
      const fileId = fileOfClass.get(cls.id);
      if (!fileId || graph.node(fileId)?.properties.language !== "java") continue;
      const written: string[] = [];
      for (const key of ["extendsNames", "implementsNames"]) {
        if (typeof cls.properties[key] === "string") written.push(...(JSON.parse(String(cls.properties[key])) as string[]));
      }
      if (written.length === 0) continue;
      const services = serviceNamesOf(written, importsByFile.get(fileId) ?? { single: [], wildcard: [] });
      if (services.length !== 1) continue;
      const service = services[0]!;
      const known = declared.get(service);
      for (const fn of methodsByOwner.get(cls.id) ?? []) {
        if (!hasGrpcSignature(fn)) continue;
        const name = String(fn.properties.name);
        if (known && !known.has(name)) continue;
        entrypoints.push({ fileId, service, fn });
        let byName = served.get(service);
        if (!byName) served.set(service, byName = new Map());
        byName.set(name, [...byName.get(name) ?? [], fn]);
      }
    }
    if (served.size === 0) return;
    for (const { fileId, service, fn } of entrypoints) {
      addJavaEntryPoint(graph, { fileId, kind: "grpc", trigger: `${service}/${String(fn.properties.name)}`, line: Number(fn.properties.line), handler: fn, library: "grpc-java" });
    }

    // Fields by owner class, for `stub` and `this.stub` receivers.
    const fieldsByOwner = new Map<string, Map<string, GraphNode>>();
    for (const rel of graph.relationshipsOfType("DEFINES_FIELD")) {
      const field = graph.node(rel.to);
      if (!field) continue;
      let fields = fieldsByOwner.get(rel.from);
      if (!fields) fieldsByOwner.set(rel.from, fields = new Map());
      fields.set(String(field.properties.name), field);
    }
    const stubServiceOfType = (type: string | null | undefined, fileId: string): string | null => {
      if (!type) return null;
      const parts = type.split(".");
      const last = parts.at(-1)!;
      const service = /^(\w+?)(?:Blocking|Future|BlockingV2)?Stub$/u.exec(last)?.[1];
      if (!service) return null;
      const holder = parts.at(-2);
      const check = (grpc: string) => grpc === `${service}Grpc`;
      if (holder !== undefined) return check(holder) ? service : null;
      const imports = importsByFile.get(fileId);
      const ok = imports?.single.some((source) => source.endsWith(`.${service}Grpc.${last}`)) || imports?.wildcard.some((source) => source.endsWith(`.${service}Grpc`));
      return ok ? service : null;
    };
    const classByName = new Map<string, GraphNode>();
    for (const cls of graph.nodesWithLabel("Class")) classByName.set(String(cls.properties.qualifiedName), cls);
    const localsOf = (fn: GraphNode): Record<string, { type?: string } | null> => {
      try {
        return JSON.parse(String(fn.properties.javaLocals ?? "{}")) as Record<string, { type?: string } | null>;
      } catch {
        return {};
      }
    };
    // The service of a stub held by `name`: a local or parameter, else a field of the class or its enclosing classes.
    const stubServiceOfName = (written: string, fn: GraphNode, fileId: string): string | null => {
      const explicitThis = written.startsWith("this.");
      const name = explicitThis ? written.slice(5) : written;
      if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(name)) return null;
      const locals = localsOf(fn);
      if (!explicitThis && name in locals) return stubServiceOfType(locals[name]?.type, fileId) ?? stubInfo.get(fn.id)?.locals[name] ?? null;
      for (let owner = ownerOf.get(fn.id); owner; owner = typeof owner.properties.outer === "string" ? classByName.get(owner.properties.outer) : undefined) {
        const field = fieldsByOwner.get(owner.id)?.get(name);
        if (field) return stubServiceOfType(typeof field.properties.typeName === "string" ? field.properties.typeName : null, fileId);
      }
      return null;
    };
    const stubServiceOfCall = (call: GraphNode, fn: GraphNode, fileId: string): string | null => {
      const info = stubInfo.get(fn.id)?.calls[`${String(call.properties.line)}:${String(call.properties.columnNumber)}`];
      if (info?.service) return info.service;
      const receiver = info?.base ?? (typeof call.properties.receiver === "string" ? call.properties.receiver : null);
      return receiver ? stubServiceOfName(receiver, fn, fileId) : null;
    };

    const callerOf = new Map<string, string>();
    for (const rel of graph.relationshipsOfType("CALLS")) callerOf.set(rel.to, rel.from);
    const relationships: GraphRelationship[] = [];
    const wanted = new Set([...served.values()].flatMap((byName) => [...byName.keys()]));
    for (const call of graph.nodesWithLabel("Call")) {
      if (call.properties.callKind !== "method" || !wanted.has(String(call.properties.callee))) continue;
      const callerId = callerOf.get(call.id);
      const fn = callerId ? graph.node(callerId) : undefined;
      const fileId = callerId ? fileOfFunction.get(callerId) : undefined;
      if (!fn || !fileId) continue;
      const service = stubServiceOfCall(call, fn, fileId);
      if (!service) continue;
      for (const target of served.get(service)?.get(String(call.properties.callee)) ?? []) {
        relationships.push({ from: call.id, to: target.id, type: "CALL_RESOLVES_TO", properties: { via: "grpc" } });
      }
    }
    for (const rpc of graph.nodesWithLabel("Rpc")) {
      const service = String(rpc.properties.service).split(".").at(-1)!;
      for (const target of served.get(service)?.get(lowerFirst(String(rpc.properties.name))) ?? []) {
        relationships.push({ from: rpc.id, to: target.id, type: "RPC_IMPLEMENTED_BY", properties: {} });
      }
    }
    graph.addRelationships(relationships);
  },
};

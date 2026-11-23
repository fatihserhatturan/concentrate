import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { GraphSchemaExtension } from "../../../core/graph/schema.js";
import type { VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";
import type { CSharpType } from "../../languages/csharp/types.js";
import { addCSharpEntryPoint } from "./emit.js";
import { usingsInScope } from "../../languages/csharp/namespaces.js";
import { csharpFileOfId, csharpMethods, parametersOf, primaryParametersOf } from "./shared.js";
import { csharpTypeResolver } from "./type-names.js";

// gRPC .NET between services of the scan, as frameworks/java/grpc.ts does for Java.
//
// Server side: a concrete class deriving from the generated `X.XBase` (Grpc.Tools generates it nested in the static
// class `X`; usually NOT in the scan, then it is recognised by name: the last two segments of the base as written are
// `X.XBase`) serves the service X. Each `public override` method of it (or of a scanned ancestor class, unless
// overridden again) with a gRPC signature (a parameter of type `ServerCallContext`) is an EntryPoint (kind `grpc`,
// library `grpc-dotnet`, trigger `X/Method`). When the generated code is in the scan (obj/ or committed) the method
// must be one the generated base declares; else, when a `.proto` of the scan declares the service, one of its rpcs.
// `MapGrpcService<T>()` is read as the property `registered` (true when the class is `T` of some call, else false);
// it is never required.
//
// Client side: a call of `Method` / `MethodAsync` on a receiver typed `X.XClient` (a local, parameter, field,
// property or primary-constructor parameter of the calling class or an enclosing one, `this.field`, or
// `new X.XClient(channel)` in place; a `var` holding `new X.XClient(…)` or `….CreateClient<X.XClient>(…)`) resolves
// (CALL_RESOLVES_TO, `via: "grpc"`) to the method of each class serving X with that name; several implementations
// are all linked. A `.proto` rpc gets RPC_IMPLEMENTED_BY to those methods.
//
// A bare `XClient` (no `X.` qualifier) that resolves to no scanned type counts only when the file shows gRPC: a
// `using Grpc.*`, a `using static` of the service class, or an alias of `X.XClient`; a REST `OrderClient` does not link.
//
// Never guessed: a receiver whose type is unknown, a client type that resolves to a scanned class other than a
// generated one. The proto service is matched by its simple name (like Java); `option csharp_namespace` is not kept
// in the graph, so two protos with one service name in different packages both link.

// Nothing is read at parse time: Call nodes already keep receiver, callee and type arguments.
export const csharpGrpcPlugin: VersionedCSharpParsePlugin = () => {};

const BASE = /(?:^|\.)(\w+)\.\1Base$/u;
const CLIENT = /(?:^|\.)(\w+)\.\1Client$/u;
const OBJECT_METHODS = new Set(["ToString", "Equals", "GetHashCode", "Finalize", "Dispose"]);

function hasGrpcSignature(fn: GraphNode): boolean {
  if (fn.properties.kind !== "method" || fn.properties.isStatic === true || fn.properties.visibility !== "public" || fn.properties.isOverride !== true) return false;
  if (OBJECT_METHODS.has(String(fn.properties.name))) return false;
  return parametersOf(fn).some((parameter) => parameter.type.replace(/\s+/gu, "").split(".").at(-1) === "ServerCallContext");
}

type Local = { type?: string; initializer?: string } | null;

export const csharpGrpcContributor: ISemanticContributor = {
  id: "csharp.grpc",
  contribute(graph) {
    const resolver = csharpTypeResolver(graph);
    const methods = csharpMethods(graph);
    const fileOfFunction = new Map(methods.map((method) => [method.node.id, method.fileId]));

    // Rpcs the scan declares: .proto services (by simple name) and generated bases (a scanned `X.XBase`).
    const protoRpcs = new Map<string, Set<string>>();
    for (const rpc of graph.nodesWithLabel("Rpc")) {
      const service = String(rpc.properties.service).split(".").at(-1)!;
      let names = protoRpcs.get(service);
      if (!names) protoRpcs.set(service, names = new Set());
      names.add(String(rpc.properties.name));
    }
    const generated = new Map<string, Set<string>>();
    for (const type of resolver.index.types) {
      const match = BASE.exec(type.qualifiedName);
      if (!match || type.node.label !== "Class") continue;
      const names = generated.get(match[1]!) ?? new Set<string>();
      for (const fn of resolver.methodsOf(type)) if (fn.properties.kind === "method" && fn.properties.visibility === "public") names.add(String(fn.properties.name));
      generated.set(match[1]!, names);
    }

    // The service a class serves: an external `X.XBase` in its base chain, or a scanned generated base.
    const serviceOf = (type: CSharpType): string | null => {
      const services = new Set<string>();
      for (const base of resolver.externalBases(type)) {
        const match = BASE.exec(base.name);
        if (match) services.add(match[1]!);
      }
      const seen = new Set<string>();
      const stack: CSharpType[] = [type];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (seen.has(current.id)) continue;
        seen.add(current.id);
        const match = BASE.exec(current.qualifiedName);
        if (match && current !== type && current.node.label === "Class") services.add(match[1]!);
        stack.push(...resolver.index.supertypes(current));
      }
      return services.size === 1 ? [...services][0]! : null;
    };

    // `MapGrpcService<T>()` registrations.
    const registeredTypes = new Set<string>();
    for (const call of graph.nodesWithLabel("Call")) {
      if (call.properties.callee !== "MapGrpcService" || typeof call.properties.typeArguments !== "string") continue;
      const resolved = resolver.resolve(String(call.properties.typeArguments).split(",")[0]!.trim(), call);
      if (resolved) registeredTypes.add(resolved.id);
    }

    const classChain = (type: CSharpType): CSharpType[] => {
      const chain: CSharpType[] = [];
      const seen = new Set<string>();
      for (let current: CSharpType | undefined = type; current && !seen.has(current.id); current = resolver.index.supertypes(current).find((parent) => parent.node.label === "Class")) {
        seen.add(current.id);
        chain.push(current);
      }
      return chain;
    };

    // Serving classes: service → method name → handlers.
    const served = new Map<string, Map<string, GraphNode[]>>();
    const entrypoints: Array<{ fileId: string; service: string; fn: GraphNode; cls: CSharpType }> = [];
    for (const type of resolver.index.types) {
      const cls = type.node;
      if (cls.label !== "Class" || cls.properties.kind !== "class" || cls.properties.isAbstract === true || BASE.test(type.qualifiedName)) continue;
      const service = serviceOf(type);
      if (!service) continue;
      const known = generated.get(service) ?? protoRpcs.get(service);
      const taken = new Set<string>();
      for (const owner of classChain(type)) {
        if (BASE.test(owner.qualifiedName)) break;
        for (const fn of resolver.methodsOf(owner)) {
          const name = String(fn.properties.name);
          if (taken.has(name) || !hasGrpcSignature(fn)) continue;
          taken.add(name);
          if (known && !known.has(name)) continue;
          const fileId = fileOfFunction.get(fn.id);
          if (!fileId) continue;
          entrypoints.push({ fileId, service, fn, cls: type });
          let byName = served.get(service);
          if (!byName) served.set(service, byName = new Map());
          byName.set(name, [...byName.get(name) ?? [], fn]);
        }
      }
    }
    if (served.size === 0) return;
    for (const { fileId, service, fn, cls } of entrypoints) {
      const entry = addCSharpEntryPoint(graph, { fileId, kind: "grpc", trigger: `${service}/${String(fn.properties.name)}`, line: Number(fn.properties.line), handler: fn, library: "grpc-dotnet" });
      entry.properties.registered = registeredTypes.has(cls.id);
    }

    // Client side.
    const fieldsByOwner = new Map<string, Map<string, GraphNode>>();
    for (const rel of graph.relationshipsOfType("DEFINES_FIELD")) {
      const field = graph.node(rel.to);
      if (!field) continue;
      let fields = fieldsByOwner.get(rel.from);
      if (!fields) fieldsByOwner.set(rel.from, fields = new Map());
      fields.set(String(field.properties.name), field);
    }
    // An unresolved bare `XClient` is the generated client only when the file shows gRPC: a `using Grpc.*`, a `using static`
    // of the service class (`using static Ns.X`), or an alias of `X.XClient`. A REST `OrderClient` stays out.
    const bareClientImported = (text: string, service: string, scope: GraphNode): boolean => {
      const fileId = csharpFileOfId(scope.id);
      const where = resolver.scopeOf(scope);
      if (!fileId || !where) return false;
      const usings = usingsInScope(graph, fileId, where.namespace ?? "", where.line);
      if (usings.namespaces.some((namespace) => namespace === "Grpc" || namespace.startsWith("Grpc."))) return true;
      if (usings.staticTypes.some((target) => target === service || target.endsWith(`.${service}`))) return true;
      const alias = usings.aliases.get(text);
      return alias !== undefined && CLIENT.test(alias.replace(/\s+/gu, ""));
    };
    const clientServiceOfType = (written: string | null | undefined, scope: GraphNode): string | null => {
      if (!written) return null;
      const text = written.replace(/\s+/gu, "").replace(/\?$/u, "");
      const qualified = /(?:^|\.)(\w+)\.(\w+)Client$/u.exec(text);
      const bare = /^(\w+)Client$/u.exec(text);
      const service = qualified && qualified[1] === qualified[2] ? qualified[1]! : bare ? bare[1]! : null;
      if (!service || !served.has(service)) return null;
      const resolved = resolver.resolve(text, scope);
      if (resolved) return CLIENT.test(resolved.qualifiedName) ? service : null;
      if (qualified && qualified[1] === qualified[2]) return service;
      return bareClientImported(text, service, scope) ? service : null;
    };
    const typeOfInitializer = (initializer: string): string | null => /(?:CreateClient|GetRequiredService|GetService)<\s*([\w.]+)\s*>/u.exec(initializer)?.[1] ?? null;
    const localsOf = (fn: GraphNode): Record<string, Local> => {
      try {
        return JSON.parse(String(fn.properties.csharpLocals ?? "{}")) as Record<string, Local>;
      } catch {
        return {};
      }
    };
    const ownerOfFunction = new Map(methods.map((method) => [method.node.id, method.owner]));
    const serviceOfName = (written: string, fn: GraphNode): string | null => {
      const explicitThis = written.startsWith("this.");
      const name = explicitThis ? written.slice(5) : written;
      if (!/^[\p{L}_][\p{L}\p{N}_]*$/u.test(name)) return null;
      const locals = localsOf(fn);
      if (!explicitThis && name in locals) {
        const local = locals[name];
        if (!local) return null;
        return clientServiceOfType(local.type ?? (local.initializer ? typeOfInitializer(local.initializer) : null), fn);
      }
      const start = ownerOfFunction.get(fn.id);
      for (let type = start ? resolver.typeOf(start) : undefined; type; type = resolver.index.enclosing(type) ?? undefined) {
        const field = fieldsByOwner.get(type.id)?.get(name);
        if (field) return clientServiceOfType(typeof field.properties.declaredType === "string" ? field.properties.declaredType : null, fn);
        const primary = primaryParametersOf(type.node).find((parameter) => parameter.name === name);
        if (primary) return clientServiceOfType(primary.type, fn);
      }
      return null;
    };

    const callerOf = new Map<string, string>();
    for (const rel of graph.relationshipsOfType("CALLS")) callerOf.set(rel.to, rel.from);
    const relationships: GraphRelationship[] = [];
    const methodNames = new Set([...served.values()].flatMap((byName) => [...byName.keys()]));
    for (const call of graph.nodesWithLabel("Call")) {
      if (call.properties.callKind !== "method" || typeof call.properties.receiver !== "string") continue;
      const callee = String(call.properties.callee);
      const name = methodNames.has(callee) ? callee : callee.endsWith("Async") && methodNames.has(callee.slice(0, -"Async".length)) ? callee.slice(0, -"Async".length) : null;
      if (!name) continue;
      const callerId = callerOf.get(call.id);
      const fn = callerId ? graph.node(callerId) : undefined;
      if (!fn || !fileOfFunction.has(fn.id)) continue;
      const receiver = call.properties.receiver.replace(/\s+/gu, "");
      const created = /^new([\w.]+?)\(/u.exec(receiver);
      const service = created ? clientServiceOfType(created[1]!, fn) : serviceOfName(receiver, fn);
      if (!service) continue;
      for (const target of served.get(service)?.get(name) ?? []) {
        relationships.push({ from: call.id, to: target.id, type: "CALL_RESOLVES_TO", properties: { via: "grpc" } });
      }
    }
    for (const rpc of graph.nodesWithLabel("Rpc")) {
      const service = String(rpc.properties.service).split(".").at(-1)!;
      for (const target of served.get(service)?.get(String(rpc.properties.name)) ?? []) {
        relationships.push({ from: rpc.id, to: target.id, type: "RPC_IMPLEMENTED_BY", properties: {} });
      }
    }
    graph.addRelationships(relationships);
  },
};

// `registered` on the grpc EntryPoints: whether a `MapGrpcService<T>()` call names the serving class.
export const csharpGrpcSchema: GraphSchemaExtension = {
  id: "csharp-grpc",
  nodeProperties: [{ label: "EntryPoint", after: "handlerName", properties: { registered: "BOOLEAN" } }],
};

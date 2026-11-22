import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { csharpStringLiteral } from "./attributes.js";
import { createCSharpInjectionResolver, injectsRelationship } from "./di.js";
import { jsonList, parametersOf, type CSharpParameterInfo } from "./shared.js";

// Minimal-API handler parameters (`via: "handler-parameter"`). ASP.NET binds a handler parameter from the route, the query
// string, the body, a header, a form or the services, in that order of inference: an explicit `[FromServices]` /
// `[FromKeyedServices]` is a service; without an attribute a parameter is a service when its type is one the container knows
// (and it is not a route value or a primitive). So the parameters read here are those of the route's handler (a method group's
// Function parameters, or the typed lambda parameters kept on the Route as `handlerParameters`), minus the ones bound
// elsewhere (primitives, `string`, route-template names, `[FromRoute]`/`[FromQuery]`/`[FromBody]`/`[FromHeader]`/`[FromForm]`/
// `[AsParameters]`, framework types like `HttpContext` / `CancellationToken`), resolved with the DI resolver of `csharp.di`.
//
// A separate contributor (not part of di.ts or routes.ts) because it needs both halves: the Routes of `csharp.routes` and the
// registrations of `csharp.di`; it runs after both and only adds edges.
//
// The INJECTS table links Class -> Class, so the consumer is the class that declares the handler method (`TodoHandlers`), or the
// class declaring the method that holds the lambda. A lambda written in top-level statements (`Program.cs`) has no class: its
// parameters are read but there is nowhere to attach the edge, so nothing is emitted (the calls on those parameters still
// resolve to the implementations through the call graph, which is what `impact_of` follows).

const BINDING_ATTRIBUTES = new Set(["FromRoute", "FromQuery", "FromBody", "FromHeader", "FromForm", "AsParameters"]);
const PRIMITIVES = new Set([
  "string", "bool", "byte", "sbyte", "short", "ushort", "int", "uint", "long", "ulong", "float", "double", "decimal", "char", "object",
  "String", "Boolean", "Byte", "SByte", "Int16", "UInt16", "Int32", "UInt32", "Int64", "UInt64", "Single", "Double", "Decimal", "Char",
  "Guid", "DateTime", "DateTimeOffset", "DateOnly", "TimeOnly", "TimeSpan", "Uri", "Version",
]);
// Types ASP.NET binds from the request or the framework, never from a registration.
const FRAMEWORK_TYPES = new Set([
  "HttpContext", "HttpRequest", "HttpResponse", "CancellationToken", "ClaimsPrincipal", "Stream", "PipeReader", "IFormFile", "IFormFileCollection",
  "IFormCollection", "IServiceProvider", "ConnectionInfo", "ISession", "IHeaderDictionary", "IQueryCollection", "WebSocket",
]);

const simpleAnnotation = (name: string): string => (name.split(".").at(-1) ?? name).replace(/Attribute$/u, "");
const bareType = (type: string): string => type.replace(/\s+/gu, "").replace(/^global::/u, "").replace(/\?$/u, "").replace(/<.*$/u, "").split(".").at(-1) ?? type;

function keyRequest(parameter: CSharpParameterInfo): { key?: string | null; keyKnown?: boolean } | undefined {
  const annotation = parameter.annotations?.find((entry) => simpleAnnotation(entry.name) === "FromKeyedServices");
  if (!annotation) return undefined;
  const literal = annotation.args[0] !== undefined ? csharpStringLiteral(annotation.args[0]) : null;
  return literal === null ? { key: null, keyKnown: false } : { key: literal };
}

function candidateService(parameter: CSharpParameterInfo, routeNames: ReadonlySet<string>): boolean {
  if (parameter.modifier === "out" || parameter.modifier === "ref" || parameter.modifier === "in" || parameter.type === "") return false;
  const annotations = (parameter.annotations ?? []).map((entry) => simpleAnnotation(entry.name));
  if (annotations.some((name) => name === "FromServices" || name === "FromKeyedServices")) return true;
  if (annotations.some((name) => BINDING_ATTRIBUTES.has(name))) return false;
  if (routeNames.has(parameter.name)) return false;
  const bare = bareType(parameter.type);
  return !PRIMITIVES.has(bare) && !FRAMEWORK_TYPES.has(bare) && !parameter.type.endsWith("[]");
}

export const csharpHandlerInjectionContributor: ISemanticContributor = {
  id: "csharp.handler-injection",
  dependsOn: ["csharp.routes", "csharp.di"],
  contribute(graph) {
    const routes = graph.nodesWithLabel("Route").filter((route) => route.properties.framework === "aspnet-minimal");
    if (routes.length === 0) return;
    const handlerOf = new Map<string, GraphNode>();
    for (const relationship of graph.relationshipsOfType("ROUTE_HANDLED_BY")) {
      const handler = graph.node(relationship.to);
      if (handler) handlerOf.set(relationship.from, handler);
    }
    const resolver = createCSharpInjectionResolver(graph);
    const added = new Set<string>();
    const relationships: GraphRelationship[] = [];
    const ambiguous = new Map<string, number>();
    for (const route of routes) {
      const handler = handlerOf.get(route.id);
      if (!handler) continue;
      const handlerName = route.properties.handlerName;
      let parameters: CSharpParameterInfo[];
      if (handlerName === "<lambda>") parameters = jsonList<CSharpParameterInfo>(route.properties.handlerParameters);
      else if (handlerName === handler.properties.name) parameters = parametersOf(handler);
      else continue; // a local function (linked to its enclosing Function under another name): its parameters are not kept
      if (parameters.length === 0) continue;
      const owner = resolver.types.ownerOf(handler);
      if (!owner) continue;
      const path = typeof route.properties.path === "string" ? route.properties.path : "";
      const routeNames = new Set([...path.matchAll(/\{\*{0,2}([A-Za-z_]\w*)/gu)].map((match) => match[1]!));
      for (const parameter of parameters) {
        if (!candidateService(parameter, routeNames)) continue;
        const result = resolver.resolve(parameter.type, handler, keyRequest(parameter));
        const key = `${handler.id}\0${parameter.name}\0${parameter.type}`;
        const seen = added.has(`point\0${key}`);
        added.add(`point\0${key}`);
        // The same handler can serve several routes (`MapMethods`): count and link each point once.
        if (seen) continue;
        if (result.ambiguous) ambiguous.set(owner.id, (ambiguous.get(owner.id) ?? 0) + 1);
        for (const target of result.targets) {
          if (target.id === owner.id) continue;
          const edge = `edge\0${owner.id}\0${target.id}\0${parameter.name}`;
          if (added.has(edge)) continue;
          added.add(edge);
          relationships.push(injectsRelationship(owner.id, target.id, parameter.name, "handler-parameter"));
        }
      }
    }
    for (const relationship of relationships) graph.addRelationship(relationship);
    for (const [ownerId, count] of ambiguous) {
      const owner = graph.node(ownerId);
      if (owner) owner.properties.ambiguousInjections = Number(owner.properties.ambiguousInjections ?? 0) + count;
    }
  },
};

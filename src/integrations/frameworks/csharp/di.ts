import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { GraphSchemaExtension } from "../../../core/graph/schema.js";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";
import { typeText } from "../../languages/csharp/syntax.js";
import type { CSharpType } from "../../languages/csharp/types.js";
import { csharpAttributeReader, csharpStringLiteral, hasAttribute } from "./attributes.js";
import { invocationInfo, lambdaInfo, type ArgumentInfo } from "./invocations.js";
import { csharpUsingIndexOf } from "../../languages/csharp/namespaces.js";
import { csharpFileOfId, parametersOf, primaryParametersOf, type CSharpParameterInfo } from "./shared.js";
import { csharpTypeResolver, type CSharpTypeResolver } from "./type-names.js";

// C# dependency injection (Microsoft.Extensions.DependencyInjection), as INJECTS between classes like Java and Go.
//   - providers: `services.AddScoped/AddTransient/AddSingleton` and `TryAdd*`, `AddKeyed*`, with `<IFoo, Foo>`,
//     `<Foo>`, `(typeof(IFoo), typeof(Foo))`, open generics (`typeof(IRepo<>), typeof(Repo<>)`), factory lambdas
//     (`AddScoped<IFoo>(sp => new Foo())`: the implementation is the `new` type when the lambda is just that, else the
//     registration provides nothing known) and instances (`AddSingleton<IFoo>(new Foo())`). `AddHttpClient<IFoo, Foo>`
//     (Transient) and `AddDbContext<T>` (Scoped) are providers too. The receiver is not checked (`services`,
//     `builder.Services`, a `this IServiceCollection` parameter, fluent chains all work): the method name and shape decide.
//     The implementation class gets `diStereotype` (the lifetime: Scoped, Transient, Singleton; the first registration
//     in source order wins) and `diBeanName` (its name). `AddOptions`, `Configure<T>`, `IOptions<T>`, `ILogger<T>`,
//     `IConfiguration` and every other type outside the scan are ignored (neither linked nor counted).
//   - consumers: the classes registered as providers, plus the framework-created ones (controllers: `ControllerBase`,
//     `Controller` or `[ApiController]`; `Hub`; `BackgroundService` / `IHostedService`; Razor `PageModel`; gRPC service
//     bases; the type of `AddHostedService<T>`, `MapHub<T>`, `MapGrpcService<T>`; Azure Functions classes with `[Function]`).
//   - injection points: the constructor Microsoft DI would pick (the only public instance constructor, else the one with
//     the most parameters; a tie at the maximum is not guessed: no point), the primary constructor of a class or record
//     (it counts as a constructor), and `[FromServices]` / `[FromKeyedServices("k")]` parameters of any method of a
//     consumer. `IEnumerable<IFoo>` injects every provider of IFoo (not the keyed ones).
//   - `consumer -INJECTS-> implementation` with `fieldName` (parameter name) and `via` (constructor,
//     primary-constructor, from-services; `handler-parameter` is added by handler-injection.ts). The service type must match exactly (Microsoft
//     DI has no subtype lookup); a closed generic point (`IRepo<User>`) matches an open registration and the same closed
//     one. Exactly one distinct implementation resolves; two or more (Microsoft DI would take the last, the issue wants
//     ambiguity reported) add one to the consumer's `ambiguousInjections` and link nothing. A factory registration whose
//     type is unknown counts as a candidate but is never linked. Scanned types with no registration are neither linked
//     nor counted, except a registered class asked for by its own type.
//   - keys: `AddKeyedX<I, C>("k")` is matched by the literal key of `[FromKeyedServices("k")]`; an unkeyed point only sees
//     unkeyed registrations. A key that is not a string literal is never guessed (it may match anything).
// Minimal-API handler parameters are read by handler-injection.ts (it reuses `resolveCSharpInjection`).
// Not handled: `RemoveAll` / `Replace`, assembly scanning (Scrutor), `[ActivatorUtilitiesConstructor]`, Autofac modules.

type Registration = {
  method: string;
  lifetime: string | null;
  service: string | null;
  impl: string | null;
  /** "type": impl written as a type; "new": impl is the `new X()` of a factory or instance; "unknown": factory or instance of unknown type. */
  implKind: "type" | "new" | "unknown";
  keyed: boolean;
  /** The literal key; null when it is not a string literal (`keyKnown` false). */
  key: string | null;
  keyKnown: boolean;
  /** `TryAdd*`: only registers when the service has no registration yet. */
  try?: boolean;
  line: number;
};

const LIFETIME_METHOD = /^(?:Try)?Add(Keyed)?(Scoped|Transient|Singleton)$/u;

function newTypeOf(node: SyntaxNode | null | undefined): string | null | undefined {
  let current = node;
  while (current?.type === "parenthesized_expression") current = current.namedChildren[0] ?? null;
  if (!current) return undefined;
  if (current.type === "object_creation_expression") {
    const type = current.childForFieldName("type");
    return type ? typeText(type) : undefined;
  }
  if (current.type === "implicit_object_creation_expression") return null; // `new()`: the service type itself
  return undefined;
}

// `new Foo(...)` when a factory lambda is nothing else: expression body, or a block with one `return new Foo(...)`.
function factoryNewType(argument: ArgumentInfo): string | null | undefined {
  const lambda = lambdaInfo(argument.node);
  if (!lambda?.body) return undefined;
  if (lambda.body.type !== "block") return newTypeOf(lambda.body);
  const statements = lambda.body.namedChildren.filter((child) => child.type !== "comment");
  if (statements.length !== 1 || statements[0]!.type !== "return_statement") return undefined;
  return newTypeOf(statements[0]!.namedChildren.find((child) => child.type !== "comment"));
}

function factoryImpl(argument: ArgumentInfo, service: string | null): [string | null, Registration["implKind"]] {
  const made = factoryNewType(argument);
  if (made === undefined) return [null, "unknown"];
  return [made ?? service, "new"];
}

function instanceImpl(argument: ArgumentInfo, service: string | null): [string | null, Registration["implKind"]] {
  const made = newTypeOf(argument.node);
  if (made === undefined) return [null, "unknown"];
  return [made ?? service, "new"];
}

function registrationOf(call: SyntaxNode): Registration | null {
  const info = invocationInfo(call);
  if (!info) return null;
  const line = call.startPosition.row + 1;
  const lifetimeMatch = LIFETIME_METHOD.exec(info.name);
  const { typeArguments } = info;
  let args = [...info.arguments];
  let lifetime: string;
  let service: string | null = null;
  let impl: string | null = null;
  let implKind: Registration["implKind"] = "type";
  let key: string | null = null;
  let keyKnown = true;
  let keyed = false;

  if (lifetimeMatch) {
    lifetime = lifetimeMatch[2]!;
    keyed = lifetimeMatch[1] !== undefined;
    if (keyed) {
      // Keyed: the key is the first argument of the generic forms, the second of `(typeof(S), key, typeof(I))`.
      const index = typeArguments.length > 0 ? 0 : 1;
      const keyArg = args[index];
      if (keyArg) {
        key = keyArg.kind === "string" ? keyArg.value! : null;
        keyKnown = keyArg.kind === "string";
        args = args.filter((_, i) => i !== index);
      } else keyKnown = false;
    }
    if (typeArguments.length >= 2) {
      service = typeArguments[0]!;
      impl = typeArguments[1]!;
    } else if (typeArguments.length === 1) {
      service = typeArguments[0]!;
      const [first] = args;
      if (!first) impl = service;
      else if (first.kind === "lambda") [impl, implKind] = factoryImpl(first, service);
      else [impl, implKind] = instanceImpl(first, service);
    } else {
      const typeofs = args.filter((arg) => arg.kind === "typeof");
      if (typeofs.length === 0) return null; // a `ServiceDescriptor` or other overload: unknown shape
      service = typeofs[0]!.typeName ?? null;
      const second = args[1];
      if (!second) impl = service;
      else if (second.kind === "typeof") impl = second.typeName ?? null;
      else if (second.kind === "lambda") [impl, implKind] = factoryImpl(second, service);
      else [impl, implKind] = instanceImpl(second, service);
    }
  } else if (info.name === "AddHttpClient" && typeArguments.length >= 1 && typeArguments.length <= 2) {
    lifetime = "Transient";
    service = typeArguments[0]!;
    impl = typeArguments[1] ?? service;
  } else if ((info.name === "AddDbContext" || info.name === "AddDbContextPool") && typeArguments.length >= 1 && typeArguments.length <= 2) {
    lifetime = "Scoped";
    service = typeArguments[0]!;
    impl = typeArguments[1] ?? service;
  } else return null;

  if (impl === null) implKind = "unknown";
  return { method: info.name, lifetime, service, impl, implKind, keyed, key, keyKnown, try: info.name.startsWith("TryAdd"), line };
}

// Parse-time part: the shape of each registration call (arguments, `typeof`, factory lambda bodies are not in the graph).
export const csharpDiPlugin: VersionedCSharpParsePlugin = Object.assign(
  ({ calls }: Parameters<VersionedCSharpParsePlugin>[0]) => {
    for (const { syntax, node } of calls) {
      if (syntax.type !== "invocation_expression") continue;
      const registration = registrationOf(syntax);
      if (registration) node.properties.diRegistration = JSON.stringify(registration);
    }
  },
  { version: "2" },
);

// ---- resolution

const typeArgsOf = (text: string): string[] | null => {
  const open = text.indexOf("<");
  if (open < 0 || !text.endsWith(">")) return null;
  const inner = text.slice(open + 1, -1);
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of inner) {
    if (char === "<") depth += 1;
    else if (char === ">") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(current);
      current = "";
    } else current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim());
};
const isOpenGeneric = (text: string): boolean => /<,*>$/u.test(text.replace(/\s+/gu, ""));
const plainName = (arg: string): string => arg.replace(/\s+/gu, "").replace(/global::/gu, "").replace(/\w+\./gu, "").replace(/\?/gu, "");
// `IRepo<>` / `Repo<,>` -> `IRepo<_>` / `Repo<_,_>` so the type resolver sees the arity.
const closeOpen = (text: string): string => text.replace(/\s+/gu, "").replace(/<(,*)>$/u, (_all, commas: string) => `<${Array.from({ length: commas.length + 1 }, () => "_").join(",")}>`);

type Candidate = {
  service: CSharpType;
  open: boolean;
  args: string[];
  key: string | null;
  keyKnown: boolean;
  keyed: boolean;
  target: GraphNode | null;
  line: number;
  fileId: string | undefined;
  /** `TryAdd*`. */
  try: boolean;
};

export type InjectionResolution = {
  /** The implementation classes (several only for a collection point). */
  targets: GraphNode[];
  /** More than one implementation (or a candidate of unknown type among others) and no way to choose: count it. */
  ambiguous: boolean;
};

export type InjectionRequest = {
  /** The key of `[FromKeyedServices("k")]`; undefined for an unkeyed point. */
  key?: string | null;
  /** False when the key expression is not a string literal. */
  keyKnown?: boolean;
};

export type CSharpInjectionResolver = {
  /** Resolves the type written at an injection point (`IFoo`, `IEnumerable<IFoo>`, `IRepo<User>`) in the scope of `scopeNode` (Class, Function, Field or Call). */
  resolve(typeText: string, scopeNode: GraphNode, request?: InjectionRequest): InjectionResolution;
  types: CSharpTypeResolver;
  /** Provider classes (those a registration names, with `diStereotype`). */
  isProvider(node: GraphNode): boolean;
};

const COLLECTION = /^(?:System\.Collections\.Generic\.)?IEnumerable<(.+)>$/u;

function buildResolver(graph: IGraphContributor): CSharpInjectionResolver {
  const types = csharpTypeResolver(graph);
  const usingIndex = csharpUsingIndexOf(graph);
  // A generic argument is compared by the type it resolves to (`A.User` is not `B.User`); an unresolvable one by its bare name.
  const typeKey = (text: string, scope: GraphNode): string => {
    const clean = text.replace(/\s+/gu, "").replace(/^global::/u, "").replace(/\?$/u, "");
    const nested = typeArgsOf(clean);
    const resolved = types.resolve(clean, scope);
    const base = resolved ? resolved.id : plainName(nested ? clean.slice(0, clean.indexOf("<")) : clean);
    return nested ? `${base}<${nested.map((part) => typeKey(part, scope)).join(",")}>` : base;
  };
  const argKeys = (written: string, scope: GraphNode): string[] => (typeArgsOf(written.replace(/\s+/gu, "")) ?? []).map((part) => typeKey(part, scope));
  const fileOf = (node: GraphNode): string | undefined => csharpFileOfId(node.id);
  const candidates: Candidate[] = [];
  const providers = new Map<string, string>(); // class id -> lifetime
  const registrations: Array<{ call: GraphNode; registration: Registration }> = [];
  for (const call of graph.nodesWithLabel("Call")) {
    if (typeof call.properties.diRegistration !== "string") continue;
    let registration: Registration;
    try {
      registration = JSON.parse(call.properties.diRegistration) as Registration;
    } catch {
      continue;
    }
    // Registrations in test files (fakes, overrides of a test host) never wire the product code.
    const fileId = fileOf(call);
    if (fileId && graph.node(fileId)?.properties.isTest === true) continue;
    registrations.push({ call, registration });
  }
  const visible = (viewer: string | undefined, target: string | undefined): boolean =>
    viewer === undefined || target === undefined || usingIndex === undefined || !usingIndex.projectScoped || usingIndex.canSee(viewer, target) || usingIndex.canSee(target, viewer);
  type Raw = Omit<Candidate, "service"> & { service: CSharpType | null; lifetime: string | null };
  const sameService = (a: Raw, b: Raw): boolean =>
    a.service?.id === b.service?.id && a.open === b.open && a.args.join(",") === b.args.join(",") && a.keyed === b.keyed && a.keyKnown === b.keyKnown && a.key === b.key;
  const raw: Raw[] = [];
  for (const { call, registration } of registrations) {
    const implType = registration.impl ? types.resolve(closeOpen(registration.impl), call) : null;
    const target = implType && !implType.isInterface && implType.node.properties.isAbstract !== true && implType.node.properties.kind !== "enum" ? implType.node : null;
    const service = registration.service ? types.resolve(closeOpen(registration.service), call) : null;
    const written = registration.service ?? "";
    raw.push({
      service, // null: the registration only provides (it is no candidate)
      open: isOpenGeneric(written),
      args: service ? argKeys(written, call) : [],
      key: registration.key,
      keyKnown: registration.keyKnown,
      keyed: registration.keyed,
      target,
      line: registration.line,
      fileId: fileOf(call),
      try: registration.try === true,
      lifetime: registration.lifetime,
    });
  }
  // `TryAdd*` does nothing when a plain `Add*` of the same service and key exists in a project it composes with
  // (`AddScoped<IFoo, A>(); TryAddScoped<IFoo, B>();`: B is never used, so it is neither a candidate nor a provider).
  const live = raw.filter((entry) => !entry.try || !entry.service || !raw.some((other) => !other.try && other.service && sameService(entry, other) && visible(entry.fileId, other.fileId)));
  for (const entry of live) {
    if (entry.target && entry.lifetime && !providers.has(entry.target.id)) providers.set(entry.target.id, entry.lifetime);
    if (!entry.service) continue;
    const { lifetime: _lifetime, service, ...rest } = entry;
    candidates.push({ ...rest, service });
  }
  for (const [id, lifetime] of providers) {
    const node = graph.node(id);
    if (!node || node.label !== "Class") continue;
    node.properties.diStereotype ??= lifetime;
    node.properties.diBeanName ??= String(node.properties.name);
  }
  const providerIds = new Set(providers.keys());

  const resolve = (typeTextValue: string, scopeNode: GraphNode, request: InjectionRequest = {}): InjectionResolution => {
    const none: InjectionResolution = { targets: [], ambiguous: false };
    let text = typeTextValue.replace(/\s+/gu, "").replace(/^global::/u, "").replace(/\?$/u, "");
    const many = COLLECTION.exec(text);
    if (many) text = many[1]!.replace(/\?$/u, "");
    const wanted = types.resolve(text, scopeNode);
    if (!wanted) return none;
    const wantedArgs = argKeys(text, scopeNode);
    const keyed = request.key !== undefined || request.keyKnown === false;
    // Registrations of the consumer's project, of the projects it references, and of the hosts that reference its project.
    const consumerFile = fileOf(scopeNode);
    const matches = candidates.filter((candidate) => {
      if (candidate.service.id !== wanted.id) return false;
      if (!visible(consumerFile, candidate.fileId)) return false;
      if (!candidate.open && candidate.args.join(",") !== wantedArgs.join(",")) return false;
      if (many || !keyed) return !candidate.keyed;
      if (!candidate.keyed) return false;
      return !candidate.keyKnown || request.keyKnown === false || candidate.key === (request.key ?? null);
    });
    if (matches.length === 0) {
      // A registered class asked for by its own type (`AddScoped<IFoo, Foo>` and a `Foo` parameter).
      if (!keyed && !many && !wanted.isInterface && providerIds.has(wanted.node.id)) return { targets: [wanted.node], ambiguous: false };
      return none;
    }
    if (many) {
      const targets = new Map<string, GraphNode>();
      for (const match of matches) if (match.target) targets.set(match.target.id, match.target);
      return { targets: [...targets.values()], ambiguous: false };
    }
    const distinct = new Set(matches.map((match) => match.target?.id ?? `?${match.line}`));
    if (distinct.size >= 2) return { targets: [], ambiguous: true };
    const only = matches[0]!;
    // An unknown factory result, or a registration under an unknown key, is never linked.
    if (!only.target || (keyed && (!only.keyKnown || request.keyKnown === false))) return none;
    return { targets: [only.target], ambiguous: false };
  };
  return { resolve, types, isProvider: (node) => providerIds.has(node.id) };
}

const resolvers = new WeakMap<IGraphContributor, CSharpInjectionResolver>();

/**
 * The resolver of a graph's registrations (reads the `diRegistration` of the Call nodes, marks the providers). Needs the Call
 * nodes: use it in a contributor (they are compacted after all contributors ran); cached per graph.
 */
export function createCSharpInjectionResolver(graph: IGraphContributor): CSharpInjectionResolver {
  let resolver = resolvers.get(graph);
  if (!resolver) {
    resolver = buildResolver(graph);
    resolvers.set(graph, resolver);
  }
  return resolver;
}

/**
 * For wave 2 (minimal-API handler parameters, `via: "handler-parameter"`): which implementation does `typeText` (the type of a
 * handler lambda parameter) resolve to, written in `scopeNode` (the Call node of the `MapGet(...)`, or the enclosing Function)?
 * `ambiguous` tells the caller to count the point in `ambiguousInjections` of its consumer. Framework types (HttpContext,
 * ILogger<T>), primitives and types without a registration give `{ targets: [], ambiguous: false }`. Must run after the
 * registrations are readable (a contributor after `csharp.di`, or call it from `csharp.di`'s dependents).
 */
export function resolveCSharpInjection(graph: IGraphContributor, typeTextValue: string, scopeNode: GraphNode, request?: InjectionRequest): InjectionResolution {
  return createCSharpInjectionResolver(graph).resolve(typeTextValue, scopeNode, request);
}

/** The INJECTS relationship shape every injection point uses. */
export const injectsRelationship = (consumerId: string, targetId: string, fieldName: string, via: string): GraphRelationship => ({
  from: consumerId,
  to: targetId,
  type: "INJECTS",
  properties: { fieldName, via },
});

// ---- consumers and injection points

const FRAMEWORK_BASES = ["ControllerBase", "Controller", "Hub", "BackgroundService", "IHostedService", "PageModel", "ViewComponent"] as const;
const MVC = ["Microsoft.AspNetCore.Mvc"];

const annotationSimple = (name: string): string => (name.split(".").at(-1) ?? name).replace(/Attribute$/u, "");

function keyOf(parameter: CSharpParameterInfo): InjectionRequest | null {
  const annotation = parameter.annotations?.find((entry) => annotationSimple(entry.name) === "FromKeyedServices");
  if (!annotation) return null;
  const literal = annotation.args[0] !== undefined ? csharpStringLiteral(annotation.args[0]) : null;
  return literal === null ? { key: null, keyKnown: false } : { key: literal };
}

const fromServices = (parameter: CSharpParameterInfo): boolean => parameter.annotations?.some((entry) => annotationSimple(entry.name) === "FromServices") === true;

// The consumer classes `csharp.di` scanned per graph (their `[FromServices]` parameters are already INJECTS points).
const consumerSets = new WeakMap<IGraphContributor, Set<string>>();
export const diConsumerIds = (graph: IGraphContributor): ReadonlySet<string> => consumerSets.get(graph) ?? new Set();

export const csharpDiContributor: ISemanticContributor = {
  id: "csharp.di",
  contribute(graph) {
    const resolver = createCSharpInjectionResolver(graph);
    const { types } = resolver;
    const attributes = csharpAttributeReader(graph);

    // Classes the framework creates through DI without any registration.
    const framework = new Set<string>();
    for (const call of graph.nodesWithLabel("Call")) {
      const callee = call.properties.callee;
      if (callee !== "AddHostedService" && callee !== "MapHub" && callee !== "MapGrpcService") continue;
      const typeArguments = typeof call.properties.typeArguments === "string" ? call.properties.typeArguments : "";
      if (typeArguments === "" || typeArguments.includes(",")) continue;
      const type = types.resolve(typeArguments, call);
      if (type && !type.isInterface) framework.add(type.node.id);
    }
    for (const node of graph.nodesWithLabel("Function")) {
      if (node.properties.kind !== "method" || !hasAttribute(attributes.attributesOf(node), "Function", ["Microsoft.Azure.Functions.Worker", "Microsoft.Azure.WebJobs"])) continue;
      const owner = types.ownerOf(node);
      if (owner) framework.add(owner.id);
    }

    const isConsumer = (type: CSharpType): boolean => {
      if (type.isInterface || type.node.label !== "Class") return false;
      if (type.node.properties.isStatic === true || type.node.properties.kind === "enum" || type.node.properties.kind === "delegate") return false;
      if (resolver.isProvider(type.node) || framework.has(type.node.id)) return true;
      const list = attributes.attributesOf(type.node);
      if (hasAttribute(list, "ApiController", MVC) || hasAttribute(list, "Controller", MVC)) return true;
      if (types.derivesFromExternal(type, FRAMEWORK_BASES)) return true;
      // gRPC service: a base like `Greeter.GreeterBase` outside the scan.
      return types.externalBases(type).some((base) => base.name.includes(".") && base.simpleName.endsWith("Base"));
    };

    const added = new Set<string>();
    const relationships: GraphRelationship[] = [];
    const ambiguous = new Map<string, number>();
    const counted = new Set<string>();
    const point = (consumer: GraphNode, scope: GraphNode, parameter: CSharpParameterInfo, via: string) => {
      if (parameter.modifier === "out" || parameter.modifier === "ref" || parameter.modifier === "in") return;
      const result = resolver.resolve(parameter.type, scope, keyOf(parameter) ?? undefined);
      // The same parameter of an overload (or of a second constructor shape) is one injection point.
      const pointKey = `${consumer.id}\0${parameter.name}\0${parameter.type}`;
      if (result.ambiguous && !counted.has(pointKey)) {
        counted.add(pointKey);
        ambiguous.set(consumer.id, (ambiguous.get(consumer.id) ?? 0) + 1);
      }
      for (const target of result.targets) {
        if (target.id === consumer.id) continue;
        const key = `${consumer.id}\0${target.id}\0${parameter.name}`;
        if (added.has(key)) continue;
        added.add(key);
        relationships.push(injectsRelationship(consumer.id, target.id, parameter.name, via));
      }
    };

    const consumers = new Set<string>();
    consumerSets.set(graph, consumers);
    for (const type of types.index.types) {
      if (!isConsumer(type)) continue;
      consumers.add(type.node.id);
      const methods = types.methodsOf(type);
      // The constructor Microsoft DI picks: the only public instance one, else the one with the most parameters (no tie).
      const constructors = methods.filter((fn) => fn.properties.kind === "constructor" && fn.properties.isStatic !== true && (fn.properties.methodKind === "primary" || fn.properties.visibility === "public"));
      const most = Math.max(0, ...constructors.map((fn) => parametersOf(fn).length));
      const chosen = constructors.filter((fn) => parametersOf(fn).length === most);
      if (most > 0 && chosen.length === 1) {
        const ctor = chosen[0]!;
        const primary = ctor.properties.methodKind === "primary";
        const parameters = parametersOf(ctor).length > 0 ? parametersOf(ctor) : primaryParametersOf(type.node);
        for (const parameter of parameters) point(type.node, ctor, parameter, primary ? "primary-constructor" : "constructor");
      }
      for (const fn of methods) {
        if (fn.properties.kind === "constructor") continue;
        for (const parameter of parametersOf(fn)) if (fromServices(parameter) || keyOf(parameter)) point(type.node, fn, parameter, "from-services");
      }
    }

    for (const relationship of relationships) graph.addRelationship(relationship);
    for (const [consumerId, count] of ambiguous) {
      const consumer = graph.node(consumerId);
      if (consumer) consumer.properties.ambiguousInjections = count;
    }
  },
};

// Graph schema additions of this track: the registration facts kept on a resolved Call node (a user-defined `AddScoped`).
export const csharpDiSchema: GraphSchemaExtension = {
  id: "csharp-di",
  nodeProperties: [{ label: "Call", after: "receiverTruncated", properties: { diRegistration: "STRING" } }],
};

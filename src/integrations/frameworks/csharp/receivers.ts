import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { genericTypeText, normalizeCSharpType, trailingGenericArguments } from "../../languages/csharp/syntax.js";
import type { CSharpType } from "../../languages/csharp/types.js";
import { primaryParametersOf } from "./shared.js";
import { csharpTypeResolver, type CSharpTypeResolver } from "./type-names.js";

// The declared type of the receiver of a C# call, to tell `connection.Query<T>(…)` from an unrelated `Query`, or an
// `IConfiguration` from a user's own type of that name.
//
// A receiver is the text the parser keeps on a Call node (`receiver`), used inside a Function. What it starts with decides:
//   - a name that is a parameter or a local (`csharpLocals` of the Function: explicit types, `var x = new T(…)`,
//     `(T)y`, `y as T`): its type. A local whose type is not known (`var x = F()`) shadows a field of the same name and
//     gives null; its initializer text is `initializerOf` (`var client = factory.CreateClient("x")`), and a generic
//     service lookup (`GetRequiredService<T>()`, `GetService<T>()`, `CreateClient<T>()`, `Resolve<T>()`) types it `T`;
//     `var a = b;` follows `b`;
//   - a field or property of the enclosing type, then of its scanned supertypes, then of the outer types (`this.db`,
//     `db`), or a parameter of its primary constructor: the declared type;
//   - `new T(…)`, `((T)x)` and `(x as T)`: `T`;
//   - `this`: the enclosing type;
//   - a type (`Environment`, `Outer.Inner`, `System.Environment`): the type itself (a static call; `via: "static"`);
//     `a.b` / `Holder.Db` a field or property of the type of the part before (scanned types only);
//   - any other expression (a call chain `Create().Query`, an element) gives null.
// The result keeps the type as written without generic arguments (`typeName`), the generic arguments (`typeArguments`:
// `IOptions<AppOptions>` has `["AppOptions"]`), the scanned Class/Interface when the type is one (`type`), and, for a
// scanned type, nothing else: `receiverMatches` answers whether it is a given library class (its own simple name, or, for
// a scanned type, because a base outside the scan has one of the names: `class MyDb : DbContext`).

export type CSharpReceiverType = {
  /** The type as written, generic arguments removed: `IConfiguration`, `Microsoft.Extensions.Configuration.IConfiguration`, `Environment`. */
  typeName: string;
  /** Generic arguments as written: `IOptions<AppOptions>` gives `["AppOptions"]`. */
  typeArguments: string[];
  /** The type as written with its generic arguments (`IOptions<AppOptions>`), when it has any. */
  fullType: string | null;
  /** The scanned Class / Interface the name means at the use site, else null (System, third party, unknown). */
  type: CSharpType | null;
  via: "local" | "field" | "new" | "this" | "static" | "cast" | "initializer";
};

export type CSharpReceiverResolver = {
  /**
   * The type of the receiver expression `text` (a Call node's `receiver`) used inside `fn`. With `at` (the position of
   * the use: `line` 1-based, `column` 0-based) a typed lambda / local function parameter of the lambda holding that
   * position wins over the member-wide local of the same name (`csharpLambdaLocals`).
   */
  typeOf(text: string | null | undefined, fn: GraphNode, at?: CSharpPosition): CSharpReceiverType | null;
  /** The receiver type of a Call node (null for an unqualified call). */
  typeOfCall(call: GraphNode): CSharpReceiverType | null;
  /** The initializer text of a local the receiver names when its type is unknown (`var c = factory.CreateClient("x")`), else null. */
  initializerOf(text: string | null | undefined, fn: GraphNode): string | null;
  /** The Function node a Call node is written in. */
  functionOf(call: GraphNode): GraphNode | undefined;
  /** The type resolver the receiver types are read with. */
  types: CSharpTypeResolver;
};

export type CSharpPosition = { line: number; column?: number };

type Local = { type?: string; fullType?: string; initializer?: string } | null;

const FACTORY_GENERIC = /(?:^|\.)(?:GetRequiredService|GetService|GetRequiredKeyedService|GetKeyedService|CreateClient|Resolve|ResolveKeyed|GetInstance|For|Create)<\s*([\w.?]+(?:<[^()]*>)?)\s*>\(/u;
const IDENTIFIER = /^@?[\p{L}_][\p{L}\p{N}_]*$/u;
const MAX_FOLLOW = 5;

const resolvers = new WeakMap<object, CSharpTypeResolver>();
/** `csharpTypeResolver(graph)` built once per graph (the type index is costly): what the data, config and HTTP tracks share. */
export function sharedCSharpTypeResolver(graph: IGraphContributor): CSharpTypeResolver {
  let resolver = resolvers.get(graph);
  if (!resolver) resolvers.set(graph, (resolver = csharpTypeResolver(graph)));
  return resolver;
}

const receiverResolvers = new WeakMap<object, CSharpReceiverResolver>();

export function createCSharpReceiverResolver(graph: IGraphContributor): CSharpReceiverResolver {
  let resolver = receiverResolvers.get(graph);
  if (!resolver) receiverResolvers.set(graph, (resolver = build(graph)));
  return resolver;
}

/**
 * Whether the type is one of the library classes `names` (simple names such as `["DbContext"]`). A type outside the scan
 * counts by its last name segment (`a.b.DbContext` too); a scanned type of that name does not count (the user's own
 * `IConfiguration`), but a scanned type with a base outside the scan of that name does.
 */
export function receiverMatches(type: CSharpReceiverType | null | undefined, names: readonly string[], resolver?: CSharpReceiverResolver): boolean {
  if (!type) return false;
  if (type.type === null) return names.includes(type.typeName.split(".").at(-1)!);
  return resolver !== undefined && resolver.types.derivesFromExternal(type.type, names);
}

function build(graph: IGraphContributor): CSharpReceiverResolver {
  const types = sharedCSharpTypeResolver(graph);
  const fieldsByType = new Map<string, Map<string, GraphNode>>();
  for (const type of ["DEFINES_FIELD", "DEFINES_INTERFACE_FIELD"] as const) {
    for (const rel of graph.relationshipsOfType(type as GraphRelationship["type"])) {
      const field = graph.node(rel.to);
      if (!field) continue;
      let fields = fieldsByType.get(rel.from);
      if (!fields) fieldsByType.set(rel.from, (fields = new Map()));
      if (!fields.has(String(field.properties.name))) fields.set(String(field.properties.name), field);
    }
  }
  const localsCache = new Map<string, Map<string, Local>>();
  const localsOf = (fn: GraphNode): Map<string, Local> => {
    let locals = localsCache.get(fn.id);
    if (!locals) {
      locals = new Map();
      try {
        const parsed = JSON.parse(String(fn.properties.csharpLocals ?? "{}")) as Record<string, Local>;
        for (const [name, value] of Object.entries(parsed)) locals.set(name, value);
      } catch {
        // no locals
      }
      localsCache.set(fn.id, locals);
    }
    return locals;
  };

  const scopesCache = new Map<string, Array<{ r: [number, number, number, number]; l: Record<string, Local> }>>();
  const scopesOf = (fn: GraphNode) => {
    let scopes = scopesCache.get(fn.id);
    if (!scopes) {
      scopes = [];
      if (typeof fn.properties.csharpLambdaLocals === "string") {
        try {
          scopes = JSON.parse(fn.properties.csharpLambdaLocals) as typeof scopes;
        } catch {
          scopes = [];
        }
      }
      scopesCache.set(fn.id, scopes);
    }
    return scopes;
  };
  // The parameter `name` of the innermost lambda holding `at`: `undefined` when no lambda there declares it.
  const scopedLocal = (name: string, fn: GraphNode, at: CSharpPosition | undefined): { local: Local } | undefined => {
    if (!at) return undefined;
    const column = at.column ?? 0;
    const holding = scopesOf(fn)
      .filter((scope) => name in scope.l && (at.line > scope.r[0] || (at.line === scope.r[0] && column >= scope.r[1])) && (at.line < scope.r[2] || (at.line === scope.r[2] && column <= scope.r[3])))
      .sort((a, b) => b.r[0] - a.r[0] || b.r[1] - a.r[1]);
    return holding[0] ? { local: holding[0].l[name]! } : undefined;
  };

  const describe = (written: string | null | undefined, scopeNode: GraphNode, via: CSharpReceiverType["via"]): CSharpReceiverType | null => {
    const typeName = normalizeCSharpType(written);
    if (!typeName || typeName.endsWith("[]")) return null;
    const args = trailingGenericArguments(written) ?? [];
    return { typeName, typeArguments: args, fullType: genericTypeText(written), type: types.resolve(written ?? typeName, scopeNode) ?? types.resolve(typeName, scopeNode), via };
  };

  const ownerType = (fn: GraphNode): CSharpType | undefined => {
    const owner = types.ownerOf(fn);
    return owner ? types.typeOf(owner) : undefined;
  };

  // The declared type text of member `name` of `type`, its scanned supertypes included; undefined when there is none.
  const memberType = (type: CSharpType, name: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(type.id)) return undefined;
    seen.add(type.id);
    const field = fieldsByType.get(type.id)?.get(name);
    if (field && typeof field.properties.declaredType === "string") return field.properties.declaredType;
    const primary = primaryParametersOf(type.node).find((parameter) => parameter.name === name);
    if (primary) return primary.type;
    for (const parent of types.index.supertypes(type)) {
      const found = memberType(parent, name, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const typeOfName = (name: string, fn: GraphNode, depth: number, at?: CSharpPosition): CSharpReceiverType | null => {
    const locals = localsOf(fn);
    const scoped = scopedLocal(name, fn, at);
    if (scoped || locals.has(name)) {
      const local = scoped ? scoped.local : locals.get(name);
      if (!local) return null;
      if (typeof local.type === "string") return describe(local.fullType ?? local.type, fn, "local");
      if (typeof local.initializer === "string") return typeOfInitializer(local.initializer, fn, depth);
      return null;
    }
    for (let type = ownerType(fn); type; type = types.index.enclosing(type) ?? undefined) {
      const declared = memberType(type, name);
      if (declared !== undefined) return describe(declared, fn, "field");
    }
    return null;
  };

  const typeOfInitializer = (initializer: string, fn: GraphNode, depth: number): CSharpReceiverType | null => {
    const compact = initializer.replace(/\s+/gu, "");
    const generic = FACTORY_GENERIC.exec(compact);
    if (generic) return describe(generic[1]!, fn, "initializer");
    if (IDENTIFIER.test(compact) && depth < MAX_FOLLOW) return typeOfName(compact.replace(/^@/u, ""), fn, depth + 1);
    const member = /^this\.(\w+)$/u.exec(compact);
    if (member && depth < MAX_FOLLOW) return typeOfName(member[1]!, fn, depth + 1);
    return null;
  };

  const typeOf = (rawText: string | null | undefined, fn: GraphNode, at?: CSharpPosition): CSharpReceiverType | null => {
    if (!rawText) return null;
    let text = rawText.replace(/\s+/gu, "").replace(/\?\./gu, ".").replace(/!(?=\.|$)/gu, "");
    const castMatch = /^\(([\w.<>,?]+)\)\w+$/u.exec(text);
    if (castMatch) return describe(castMatch[1], fn, "cast");
    const created = /^new([\w.]+(?:<[^()]*>)?)\(/u.exec(text);
    if (created) return describe(created[1], fn, "new");
    if (text === "this") {
      const owner = ownerType(fn);
      return owner ? { typeName: owner.qualifiedName, typeArguments: [], fullType: null, type: owner, via: "this" } : null;
    }
    if (text.startsWith("this.")) {
      const name = text.slice(5);
      if (!IDENTIFIER.test(name)) return chain(text.slice(5), ownerType(fn), fn);
      for (let type = ownerType(fn); type; type = types.index.enclosing(type) ?? undefined) {
        const declared = memberType(type, name);
        if (declared !== undefined) return describe(declared, fn, "field");
      }
      return null;
    }
    const segments = text.split(".");
    if (!segments.every((segment) => IDENTIFIER.test(segment))) return null;
    const first = segments[0]!.replace(/^@/u, "");
    if (segments.length === 1) return typeOfName(first, fn, 0, at) ?? (localsOf(fn).has(first) ? null : staticType(text, fn));
    const head = typeOfName(first, fn, 0, at);
    if (head) return chainFrom(head, segments.slice(1), fn);
    if (localsOf(fn).has(first)) return null;
    // `Holder.Db`: a type's static member; `System.Environment` / `Outer.Inner`: the type itself.
    const owner = types.resolve(text, fn);
    if (owner) return staticType(text, fn);
    for (let length = segments.length - 1; length >= 1; length -= 1) {
      const holder = types.resolve(segments.slice(0, length).join("."), fn);
      if (holder) return chain(segments.slice(length).join("."), holder, fn);
    }
    return staticType(text, fn);
  };

  const staticType = (text: string, fn: GraphNode): CSharpReceiverType | null => {
    if (!/^[\p{L}_][\p{L}\p{N}_.]*$/u.test(text)) return null;
    // A member name starts lower case by convention for a field, upper case for a type: only types are static receivers.
    if (!/^[A-Z]/u.test(text.split(".").at(-1)!)) return null;
    const found = describe(text, fn, "static");
    return found ? { ...found, via: "static" } : null;
  };

  // `a.b.c` below the type `from`: each part a field or property of the type before.
  const chain = (path: string, from: CSharpType | undefined, fn: GraphNode): CSharpReceiverType | null => {
    if (!from) return null;
    let current: CSharpType | undefined = from;
    let result: CSharpReceiverType | null = null;
    for (const name of path.split(".")) {
      if (!current) return null;
      const declared = memberType(current, name);
      if (declared === undefined) return null;
      result = describe(declared, fn, "field");
      current = result?.type ?? undefined;
    }
    return result;
  };
  const chainFrom = (head: CSharpReceiverType, rest: string[], fn: GraphNode): CSharpReceiverType | null => chain(rest.join("."), head.type ?? undefined, fn);

  const functionOf = (call: GraphNode): GraphNode | undefined => {
    const cut = call.id.indexOf(":call:");
    return cut === -1 ? undefined : graph.node(call.id.slice(0, cut));
  };

  return {
    typeOf,
    typeOfCall(call) {
      const receiver = call.properties.receiver;
      if (typeof receiver !== "string") return null;
      const fn = functionOf(call);
      if (!fn) return null;
      // `((T)x).M()` and `(x as T).M()`: the parser keeps the cast type; a typed local is read from the Function's locals.
      if (typeof call.properties.receiverType === "string" && call.properties.receiverKind === "cast") return describe(call.properties.receiverType, fn, "cast");
      const line = call.properties.line;
      const column = call.properties.columnNumber;
      return typeOf(receiver, fn, typeof line === "number" ? { line, ...(typeof column === "number" ? { column } : {}) } : undefined);
    },
    initializerOf(text, fn) {
      const name = (text ?? "").trim().replace(/^this\./u, "");
      if (!IDENTIFIER.test(name)) return null;
      const local = localsOf(fn).get(name.replace(/^@/u, ""));
      return local && typeof local.initializer === "string" && typeof local.type !== "string" ? local.initializer : null;
    },
    functionOf,
    types,
  };
}

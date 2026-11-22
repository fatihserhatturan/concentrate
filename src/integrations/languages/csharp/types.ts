import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { isCSharpFile } from "../file-kind.js";
import { csharpUsingIndexOf, usingAppliesAt } from "./namespaces.js";
import { trailingArity } from "./syntax.js";
import { csharpNamespaceIndexOf } from "./project.js";

// Type names of C# code, resolved straight from the graph nodes: a name written in a file / namespace /
// enclosing type is the Class or Interface node it means, or null (a System, third-party or unknown type).
//
// Usings come from the imports track (`csharpUsingIndexOf`), already resolved, so how a `using` resolves is
// decided in one place (`namespaces.ts`). Namespaces are read from the `namespace` property of the Class and
// Interface nodes (and `File.csharpNamespaces`), which also covers types merged from `partial` declarations.
//
// A simple name is looked up, in order, in the enclosing types (their members and inherited member types),
// then, for each enclosing namespace from the innermost to the global one, in the types of that namespace
// (every file declares them), the aliases and usings written in that namespace's declaration of the file,
// and (at the global level) the `global using`s of the whole scan. Generic arity (`Box<T>` is `Box`1`) tells
// types of one name apart; a name that stays ambiguous resolves to nothing.

export type CSharpType = {
  id: string;
  node: GraphNode;
  isInterface: boolean;
  /** Every file that declares the type (more than one for a `partial` type). */
  fileIds: readonly string[];
  name: string;
  qualifiedName: string;
  namespace: string;
  outer: string | null;
  /** class, struct, record, record struct, enum, delegate, interface */
  kind: string;
  arity: number;
};

/**
 * `fileId`: the file the use site is in; `typeId`: the innermost enclosing type, when known; `namespace`: the namespace
 * the use site is declared in; `line`: the line of the use site (tells two blocks of one namespace in a file apart: a
 * `using` written in one block does not count in the other).
 */
export type CSharpTypeScope = { fileId: string; typeId?: string | null; namespace?: string; line?: number };

/** What one namespace declaration of a file brings into scope. */
export type CSharpUsingLevel = {
  namespace: string;
  /** `using A.B;` namespaces in the order written (`global using`s are added at the global level). */
  usings: string[];
  /** `using X = A.B.C;` as alias -> dotted target. */
  aliases: Map<string, string>;
  /** alias -> number of generic arguments its target was written with (`using IntBox = N.Box<int>;` is 1), when it has any. */
  aliasArities: Map<string, number>;
  /** `using static A.B.C;` dotted type names. */
  statics: string[];
};

export type CSharpTypeIndex = {
  types: readonly CSharpType[];
  byId: ReadonlyMap<string, CSharpType>;
  /** `fileId`: the use site, when known; types of projects it cannot see are not found. */
  byQualifiedName(name: string, arity?: number, fileId?: string): CSharpType | null;
  /** Whether `type` is visible from `fileId` (same project or a transitive ProjectReference; files in no project see everything). */
  visibleFrom(fileId: string, type: CSharpType): boolean;
  /** The type `name` means when written inside `scope` (`name` may be dotted; `arity`: number of generic arguments when known). */
  resolve(name: string, scope: CSharpTypeScope, arity?: number): CSharpType | null;
  /** The type that encloses `type` (null for a top-level type). */
  enclosing(type: CSharpType): CSharpType | null;
  /** Direct supertypes: the base class, then the interfaces (the ones that resolve). */
  supertypes(type: CSharpType): readonly CSharpType[];
  /** Every type that extends or implements `type`, directly or not. */
  subtypes(type: CSharpType): readonly CSharpType[];
  /** The namespaces, aliases and static types a use site in `namespace` of `fileId` sees, innermost level first. */
  usingScope(fileId: string, namespace: string, line?: number): readonly CSharpUsingLevel[];
  /** The namespace `name` is (a declared namespace or an ancestor of one), resolved through namespace aliases of the scope. */
  namespaceNamed(name: string, scope: CSharpTypeScope): string | null;
  hasNamespace(name: string, fileId?: string): boolean;
};

const keywordTypes: ReadonlySet<string> = new Set([
  "bool", "byte", "sbyte", "char", "decimal", "double", "float", "int", "uint", "long", "ulong", "short", "ushort", "object", "string", "void", "nint", "nuint", "dynamic", "var",
]);

export type PartialFact = {
  id: string;
  name?: string;
  qualifiedName?: string;
  kind?: string;
  visibility?: string;
  modifiers?: string[];
  typeParameters?: string[];
  constraints?: Array<{ param: string; constraints: string[] }>;
  bases?: Array<{ name: string; text: string; relation: string }>;
  fields?: Array<{ name: string; type: string | null; visibility: string; isStatic: boolean }>;
  line?: number;
};

const cache = new WeakMap<object, CSharpTypeIndex>();

export function createCSharpTypeIndex(graph: IGraphContributor, index: ResolutionRelationshipIndex): CSharpTypeIndex {
  const known = cache.get(graph);
  if (known) return known;
  const created = build(graph, index);
  cache.set(graph, created);
  return created;
}

export function parseJsonList<T = unknown>(value: unknown): T[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** The names of `T, U` out of `["T", "in U"]`-style type parameter texts. */
export function typeParameterNames(node: GraphNode): string[] {
  return parseJsonList<unknown>(node.properties.typeParameters).flatMap((written) => (typeof written === "string" ? /[\p{L}_][\p{L}\p{N}_]*$/u.exec(written)?.[0] ?? [] : []));
}

/** Number of generic arguments written in `Box<int, string>` (0 when none). */
export function genericArity(text: string | null | undefined): number {
  return genericArguments(text).length;
}

/** The top-level generic arguments of `Dictionary<string, List<int>>` as written (`["string", "List<int>"]`). */
export function genericArguments(text: string | null | undefined): string[] {
  if (!text) return [];
  const open = text.indexOf("<");
  if (open < 0) return [];
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let position = open; position < text.length; position += 1) {
    const char = text[position]!;
    if (char === "<") depth += 1;
    else if (char === ">") {
      depth -= 1;
      if (depth === 0) {
        const last = text.slice(start, position).trim();
        if (last) args.push(last);
        return args;
      }
    } else if (char === "," && depth === 1) {
      args.push(text.slice(start, position).trim());
      start = position + 1;
    }
  }
  return [];
}

const accessWords = new Set(["public", "internal", "protected", "private", "file"]);

// A `partial` type has one node for all its declarations, carrying only the first declaration's facts. The facts of
// every declaration are in `File.csharpPartials`: merge them into that node (union of bases, modifiers, constraints,
// fields; an explicit accessibility on any part wins), so everything that reads the node sees the whole type.
function mergePartials(graph: IGraphContributor, partialsByNode: Map<string, PartialFact[]>): void {
  for (const [id, facts] of partialsByNode) {
    const node = graph.node(id);
    if (!node || facts.length === 0) continue;
    const props = node.properties as Record<string, unknown>;
    if (facts.length > 1 || facts.some((fact) => (fact.modifiers ?? []).length > 0)) {
      const words = new Set(facts.flatMap((fact) => fact.modifiers ?? []));
      if (node.label === "Class") {
        if (words.has("abstract")) props.isAbstract = true;
        if (words.has("static")) props.isStatic = true;
        if (words.has("sealed")) props.isSealed = true;
      }
      const explicit = facts.map((fact) => new Set((fact.modifiers ?? []).filter((word) => accessWords.has(word)))).find((set) => set.size > 0);
      if (explicit) {
        const visibility = explicit.has("protected") && explicit.has("internal") ? "protected internal" : explicit.has("private") && explicit.has("protected") ? "private protected" : [...explicit][0]!;
        if (visibility !== props.visibility) {
          props.visibility = visibility;
          props.isExported = visibility !== "private" && visibility !== "file";
        }
      }
    }
    const bases: Array<{ name: string; text: string; relation: string }> = [];
    for (const fact of facts) {
      for (const base of fact.bases ?? []) if (!bases.some((other) => other.text === base.text)) bases.push(base);
    }
    if (bases.length > 0) {
      props.bases = JSON.stringify(bases);
      props.baseNames = JSON.stringify(bases.map((base) => base.name));
      if (node.label === "Interface") props.embeds = JSON.stringify(bases.map((base) => base.name));
    }
    const constraints = new Map<string, string[]>();
    for (const fact of facts) {
      for (const entry of fact.constraints ?? []) {
        const list = constraints.get(entry.param) ?? [];
        for (const item of entry.constraints) if (!list.includes(item)) list.push(item);
        constraints.set(entry.param, list);
      }
    }
    if (constraints.size > 0) props.constraints = JSON.stringify([...constraints].map(([param, list]) => ({ param, constraints: list })));
    if (node.label === "Class") {
      const fields = new Map<string, unknown>();
      for (const field of parseJsonList<{ name: string }>(props.fields)) fields.set(field.name, field);
      for (const fact of facts) for (const field of fact.fields ?? []) if (!fields.has(field.name)) fields.set(field.name, field);
      props.fields = JSON.stringify([...fields.values()]);
    }
    const parameters = facts.map((fact) => fact.typeParameters ?? []).find((list) => list.length > 0);
    if (parameters && props.typeParameters === undefined) props.typeParameters = JSON.stringify(parameters);
  }
}

function build(graph: IGraphContributor, index: ResolutionRelationshipIndex): CSharpTypeIndex {
  // Declarations per type: the facts of each `partial` part, read before the merge.
  const partialsByNode = new Map<string, PartialFact[]>();
  const declarations = new Map<string, Array<{ fileId: string; line: number | undefined; bases: Array<{ name: string; text: string; relation: string }> }>>();
  for (const file of graph.nodesWithLabel("File")) {
    if (typeof file.properties.csharpPartials !== "string") continue;
    for (const fact of parseJsonList<PartialFact>(file.properties.csharpPartials)) {
      if (typeof fact?.id !== "string") continue;
      const list = partialsByNode.get(fact.id);
      if (list) list.push(fact);
      else partialsByNode.set(fact.id, [fact]);
      const decls = declarations.get(fact.id) ?? [];
      decls.push({ fileId: file.id, line: typeof fact.line === "number" ? fact.line : undefined, bases: fact.bases ?? [] });
      declarations.set(fact.id, decls);
    }
  }
  mergePartials(graph, partialsByNode);

  // Files of each type: one DEFINES_CLASS / DEFINES_INTERFACE edge per declaring file (`fileByClassId` keeps only one).
  const filesByType = new Map<string, string[]>();
  for (const type of ["DEFINES_CLASS", "DEFINES_INTERFACE"] as const) {
    for (const relationship of graph.relationshipsOfType(type as GraphRelationship["type"])) {
      if (!isCSharpFile(relationship.from)) continue;
      const list = filesByType.get(relationship.to);
      if (list) {
        if (!list.includes(relationship.from)) list.push(relationship.from);
      } else {
        filesByType.set(relationship.to, [relationship.from]);
      }
    }
  }
  void index;

  const types: CSharpType[] = [];
  const byId = new Map<string, CSharpType>();
  const byQualified = new Map<string, CSharpType[]>();
  const topLevelByNamespace = new Map<string, Map<string, CSharpType[]>>();
  for (const label of ["Class", "Interface"] as const) {
    for (const node of graph.nodesWithLabel(label)) {
      const fileIds = filesByType.get(node.id);
      if (!fileIds || fileIds.length === 0) continue;
      const qualifiedName = typeof node.properties.qualifiedName === "string" ? node.properties.qualifiedName : String(node.properties.name);
      const namespace = typeof node.properties.namespace === "string" ? node.properties.namespace : "";
      const type: CSharpType = {
        id: node.id,
        node,
        isInterface: label === "Interface",
        fileIds,
        name: String(node.properties.name),
        qualifiedName,
        namespace,
        outer: typeof node.properties.outer === "string" ? node.properties.outer : null,
        kind: typeof node.properties.kind === "string" ? node.properties.kind : label === "Interface" ? "interface" : "class",
        arity: typeof node.properties.arity === "number" ? node.properties.arity : 0,
      };
      types.push(type);
      byId.set(type.id, type);
      push(byQualified, qualifiedName, type);
      if (type.outer === null) {
        let inNamespace = topLevelByNamespace.get(namespace);
        if (!inNamespace) topLevelByNamespace.set(namespace, inNamespace = new Map());
        push(inNamespace, type.name, type);
      }
    }
  }

  const pick = (list: readonly CSharpType[] | undefined, arity: number | undefined): CSharpType | null => {
    if (!list || list.length === 0) return null;
    if (arity !== undefined) return list.find((type) => type.arity === arity) ?? null;
    if (list.length === 1) return list[0]!;
    const plain = list.filter((type) => type.arity === 0);
    return plain.length === 1 ? plain[0]! : null;
  };
  const scoped = csharpUsingIndexOf(graph);
  const visibleFrom = (fileId: string, type: CSharpType): boolean => scoped === undefined || !scoped.projectScoped || type.fileIds.some((id) => scoped.canSee(fileId, id));
  const visibleOnly = (list: readonly CSharpType[] | undefined, fileId: string | undefined): readonly CSharpType[] | undefined =>
    list === undefined || fileId === undefined || scoped === undefined || !scoped.projectScoped ? list : list.filter((type) => visibleFrom(fileId, type));
  const byQualifiedName = (name: string, arity?: number, fileId?: string): CSharpType | null => pick(visibleOnly(byQualified.get(name), fileId), arity);
  const enclosing = (type: CSharpType): CSharpType | null => {
    if (type.outer === null) return null;
    const list = byQualified.get(type.outer);
    if (!list || list.length === 0) return null;
    return list.find((candidate) => candidate.fileIds.some((fileId) => type.fileIds.includes(fileId))) ?? list[0]!;
  };
  const member = (owner: CSharpType, name: string, arity?: number): CSharpType | null => byQualifiedName(`${owner.qualifiedName}.${name}`, arity);

  // ---- usings ----
  // The imports track decides how a `using` resolves (scope-relative names, aliases, static types); this index only
  // groups its resolved usings per namespace level of a use site.
  const usingIndex = csharpUsingIndexOf(graph);
  const namespaceIndex = csharpNamespaceIndexOf(graph);
  const namespaceChain = (namespace: string): string[] => {
    const levels: string[] = [];
    for (let current = namespace; current !== ""; current = current.includes(".") ? current.slice(0, current.lastIndexOf(".")) : "") levels.push(current);
    levels.push("");
    return levels;
  };
  const buildUsingScope = (fileId: string, namespace: string, line: number | undefined): CSharpUsingLevel[] => {
    const own = (usingIndex?.usingsOfFile(fileId) ?? []).filter((using) => usingAppliesAt(using, line));
    return namespaceChain(namespace).map((level) => {
      const result: CSharpUsingLevel = { namespace: level, usings: [], aliases: new Map(), statics: [], aliasArities: new Map() };
      const resolved = [...own.filter((using) => using.scope === level && !using.isGlobal), ...(level === "" ? usingIndex?.globalUsingsFor(fileId) ?? [] : [])];
      for (const using of resolved) {
        if (!using.source) continue;
        if (using.kind === "alias" && using.alias !== undefined) {
          if (!result.aliases.has(using.alias)) {
            result.aliases.set(using.alias, using.target);
            if (using.arity !== undefined) result.aliasArities.set(using.alias, using.arity);
          }
        } else if (using.kind === "static") {
          if (!result.statics.includes(using.target)) result.statics.push(using.target);
        } else if (!result.usings.includes(using.target)) {
          result.usings.push(using.target);
        }
      }
      return result;
    });
  };
  const usingScopeCache = new Map<string, CSharpUsingLevel[]>();
  const usingScope = (fileId: string, namespace: string, line?: number): readonly CSharpUsingLevel[] => {
    // Usings of a namespace block count only at the lines of that block: the key holds the blocks the line is in.
    const blocks = line === undefined ? "*" : (usingIndex?.usingsOfFile(fileId) ?? []).filter((using) => using.scopeStart !== undefined && usingAppliesAt(using, line)).map((using) => using.importId).join(",");
    const key = `${fileId}\0${namespace}\0${blocks}`;
    let found = usingScopeCache.get(key);
    if (!found) usingScopeCache.set(key, found = buildUsingScope(fileId, namespace, line));
    return found;
  };

  const namespaceOfScope = (scope: CSharpTypeScope): string => {
    if (scope.namespace !== undefined) return scope.namespace;
    const own = scope.typeId ? byId.get(scope.typeId) : undefined;
    if (own) return own.namespace;
    return parseJsonList<string>(graph.node(scope.fileId)?.properties.csharpNamespaces)[0] ?? "";
  };

  const hasNamespace = (name: string, fileId?: string): boolean => (fileId !== undefined && usingIndex !== undefined ? usingIndex.hasNamespaceFor(fileId, name) : namespaceIndex.hasNamespace(name));
  const namespaceNamed = (name: string, scope: CSharpTypeScope): string | null => {
    const levels = usingScope(scope.fileId, namespaceOfScope(scope), scope.line);
    const [first, ...rest] = name.split(".");
    for (const level of levels) {
      const target = level.aliases.get(first!);
      if (target !== undefined) {
        const full = [target, ...rest].join(".");
        return hasNamespace(full, scope.fileId) ? full : null;
      }
    }
    for (const level of levels) {
      const full = level.namespace === "" ? name : `${level.namespace}.${name}`;
      if (hasNamespace(full, scope.fileId)) return full;
    }
    return null;
  };

  const topLevel = (namespace: string, name: string, arity: number | undefined, fileId: string): CSharpType | null => pick(visibleOnly(topLevelByNamespace.get(namespace)?.get(name), fileId), arity);

  const inheritedMember = (type: CSharpType, name: string, arity: number | undefined, seen: Set<string>): CSharpType | null => {
    if (seen.has(type.id)) return null;
    seen.add(type.id);
    for (const parent of supertypes(type)) {
      const found = member(parent, name, arity) ?? inheritedMember(parent, name, arity, seen);
      if (found) return found;
    }
    return null;
  };

  const resolveAliasTarget = (target: string, scope: CSharpTypeScope, arity: number | undefined, seen: Set<string>): CSharpType | null => {
    if (seen.has(target)) return null;
    seen.add(target);
    // The arity the alias was written with is never dropped: `using IntBox = N.Box<int>;` is `Box<T>`, not a plain `Box`.
    return byQualifiedName(target, arity, scope.fileId) ?? resolveDotted(target, { fileId: scope.fileId, namespace: "" }, arity, seen);
  };

  const resolveSimple = (name: string, scope: CSharpTypeScope, arity: number | undefined, seen: Set<string> = new Set()): CSharpType | null => {
    for (let current = scope.typeId ? byId.get(scope.typeId) ?? null : null; current; current = enclosing(current)) {
      if (current.name === name && (arity === undefined || current.arity === arity)) return current;
      const nested = member(current, name, arity) ?? inheritedMember(current, name, arity, new Set());
      if (nested) return nested;
    }
    for (const level of usingScope(scope.fileId, namespaceOfScope(scope), scope.line)) {
      const here = topLevel(level.namespace, name, arity, scope.fileId);
      if (here) return here;
      const target = level.aliases.get(name);
      if (target !== undefined) {
        const aliased = resolveAliasTarget(target, scope, level.aliasArities.get(name), seen);
        if (aliased) return aliased;
      }
      for (const using of level.usings) {
        const found = topLevel(using, name, arity, scope.fileId);
        if (found) return found;
      }
      for (const source of level.statics) {
        const owner = byQualifiedName(source, undefined, scope.fileId);
        const found = owner ? member(owner, name, arity) : null;
        if (found) return found;
      }
    }
    return null;
  };

  function resolveDotted(name: string, scope: CSharpTypeScope, arity: number | undefined, seen: Set<string> = new Set()): CSharpType | null {
    const segments = name.split(".");
    // `Outer.Inner`, or `Alias.Type` for a type alias: the first segment is a type.
    let current = resolveSimple(segments[0]!, scope, segments.length === 1 ? arity : undefined, seen);
    for (let position = 1; current && position < segments.length; position += 1) {
      const last = position === segments.length - 1;
      current = member(current, segments[position]!, last ? arity : undefined) ?? inheritedMember(current, segments[position]!, last ? arity : undefined, new Set());
    }
    if (current) return current;
    // `Ns.Type` or `Alias.Type` for a namespace alias, relative to every enclosing namespace.
    const [first, ...rest] = segments;
    for (const level of usingScope(scope.fileId, namespaceOfScope(scope), scope.line)) {
      const target = level.aliases.get(first!);
      if (target !== undefined && rest.length > 0) {
        const found = byQualifiedName(`${target}.${rest.join(".")}`, arity, scope.fileId);
        if (found) return found;
      }
      const full = level.namespace === "" ? name : `${level.namespace}.${name}`;
      const found = byQualifiedName(full, arity, scope.fileId);
      if (found) return found;
    }
    return null;
  }

  const resolve = (written: string, scope: CSharpTypeScope, arity?: number): CSharpType | null => {
    let name = written.replace(/^global::/u, "");
    if (name === "" || name.endsWith("[]")) return null;
    let wanted = arity;
    const tick = /`(\d+)$/u.exec(name);
    if (tick) {
      wanted = Number(tick[1]);
      name = name.slice(0, tick.index);
    }
    if (keywordTypes.has(name)) return null;
    return name.includes(".") ? resolveDotted(name, scope, wanted) : resolveSimple(name, scope, wanted);
  };

  // ---- hierarchy ----
  const supertypeCache = new Map<string, CSharpType[]>();
  function supertypes(type: CSharpType): CSharpType[] {
    const known = supertypeCache.get(type.id);
    if (known) return known;
    supertypeCache.set(type.id, []); // a cycle sees nothing
    const outerType = enclosing(type);
    const decls = declarations.get(type.id) ?? [{ fileId: type.fileIds[0]!, line: typeof type.node.properties.line === "number" ? type.node.properties.line : undefined, bases: parseJsonList<{ name: string; text: string; relation: string }>(type.node.properties.bases) }];
    const found: CSharpType[] = [];
    for (const decl of decls) {
      // A base name is written outside the type's own body: its member types are not in scope.
      const scope: CSharpTypeScope = { fileId: decl.fileId, typeId: outerType?.id ?? null, namespace: type.namespace, ...(decl.line === undefined ? {} : { line: decl.line }) };
      for (const base of decl.bases) {
        if (base.relation === "underlying") continue;
        // `Stack<int>` is a type of one generic parameter: a non-generic `Stack` is not it.
        const target = resolve(base.name, scope, trailingArity(base.text));
        if (target && target.id !== type.id && !found.includes(target)) found.push(target);
      }
    }
    // The base class first, then the interfaces.
    found.sort((left, right) => Number(left.isInterface) - Number(right.isInterface));
    supertypeCache.set(type.id, found);
    return found;
  }

  let subtypesById: Map<string, CSharpType[]> | null = null;
  const subtypes = (type: CSharpType): readonly CSharpType[] => {
    if (!subtypesById) {
      const direct = new Map<string, CSharpType[]>();
      for (const candidate of types) for (const parent of supertypes(candidate)) push(direct, parent.id, candidate);
      subtypesById = new Map();
      for (const root of types) {
        const all: CSharpType[] = [];
        const seen = new Set<string>([root.id]);
        const queue = [...direct.get(root.id) ?? []];
        while (queue.length > 0) {
          const next = queue.shift()!;
          if (seen.has(next.id)) continue;
          seen.add(next.id);
          all.push(next);
          queue.push(...direct.get(next.id) ?? []);
        }
        if (all.length > 0) subtypesById.set(root.id, all);
      }
    }
    return subtypesById.get(type.id) ?? [];
  };

  return { types, byId, byQualifiedName, visibleFrom, resolve, enclosing, supertypes, subtypes, usingScope, namespaceNamed, hasNamespace };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

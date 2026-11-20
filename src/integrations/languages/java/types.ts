import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { isJavaFile } from "../file-kind.js";
import { javaModuleFilterOf } from "./module-visibility.js";

// Type names of Java code, resolved straight from the graph nodes: a name
// written in a file (simple, nested `Outer.Inner`, or fully qualified) is the
// Class or Interface node it means, or null (a JDK or third-party type).
//
// A simple name is looked up, in order, in the enclosing types and their
// members, the types of the file, the single-type imports, the types of the
// package, and the on-demand imports. Generic arguments are already stripped
// by the parser.

export type JavaType = {
  id: string;
  node: GraphNode;
  isInterface: boolean;
  fileId: string;
  name: string;
  qualifiedName: string;
  packageName: string;
  outer: string | null;
};

/** `fnLine`: the line of the method (or initializer) of `typeId` that holds the use site, when known; local classes are visible by it. */
export type TypeScope = { fileId: string; typeId?: string | null; fnLine?: number };

export type JavaTypeIndex = {
  types: readonly JavaType[];
  byId: ReadonlyMap<string, JavaType>;
  /** `fromFile`: prefer the declaration in a module that file sees (Maven/Gradle). */
  byQualifiedName(name: string, fromFile?: string): JavaType | null;
  /** The type `name` means when written inside `scope`. */
  resolve(name: string, scope: TypeScope): JavaType | null;
  /** The type that encloses `type` (null for a top-level type). */
  enclosing(type: JavaType): JavaType | null;
  /** Direct supertypes: the superclass, then the implemented or extended interfaces (the ones that resolve). */
  supertypes(type: JavaType): readonly JavaType[];
  /** Every type that extends or implements `type`, directly or not. */
  subtypes(type: JavaType): readonly JavaType[];
};

const cache = new WeakMap<object, JavaTypeIndex>();

export function createJavaTypeIndex(graph: IGraphContributor, index: ResolutionRelationshipIndex): JavaTypeIndex {
  const known = cache.get(graph);
  if (known) return known;
  const created = build(graph, index);
  cache.set(graph, created);
  return created;
}

export function parseStringList(value: unknown): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function build(graph: IGraphContributor, index: ResolutionRelationshipIndex): JavaTypeIndex {
  const types: JavaType[] = [];
  const byId = new Map<string, JavaType>();
  const byQualified = new Map<string, JavaType[]>();
  const byFile = new Map<string, JavaType[]>();
  for (const [label, fileOf] of [["Class", index.fileByClassId], ["Interface", index.fileByInterfaceId]] as const) {
    for (const node of graph.nodesWithLabel(label)) {
      const fileId = fileOf.get(node.id);
      if (!fileId || !isJavaFile(fileId)) continue;
      const qualifiedName = typeof node.properties.qualifiedName === "string" ? node.properties.qualifiedName : String(node.properties.name);
      const type: JavaType = {
        id: node.id,
        node,
        isInterface: label === "Interface",
        fileId,
        name: String(node.properties.name),
        qualifiedName,
        packageName: typeof node.properties.namespace === "string" ? node.properties.namespace : "",
        outer: typeof node.properties.outer === "string" ? node.properties.outer : null,
      };
      types.push(type);
      byId.set(type.id, type);
      push(byQualified, qualifiedName, type);
      push(byFile, fileId, type);
    }
  }

  const importsByFile = new Map<string, GraphNode[]>();
  for (const node of graph.nodesWithLabel("Import")) {
    const fileId = index.fileByImportId.get(node.id);
    if (!fileId || !isJavaFile(fileId)) continue;
    push(importsByFile, fileId, node);
  }

  const byQualifiedName = (name: string, fromFile?: string): JavaType | null => {
    const list = byQualified.get(name);
    if (!list || list.length === 0) return null;
    const filter = fromFile === undefined || list.length === 1 ? undefined : javaModuleFilterOf(graph);
    if (!filter) return list[0]!;
    const visible = new Set(filter(fromFile!, list.map((type) => type.fileId)));
    return list.find((type) => visible.has(type.fileId)) ?? list[0]!;
  };
  const enclosing = (type: JavaType): JavaType | null => (type.outer === null ? null : byQualifiedName(type.outer));
  const member = (owner: JavaType, name: string): JavaType | null => byQualifiedName(`${owner.qualifiedName}.${name}`);

  const packageOfFile = (fileId: string): string => {
    const written = graph.node(fileId)?.properties.packageName;
    return typeof written === "string" ? written : byFile.get(fileId)?.[0]?.packageName ?? "";
  };

  const functionsByOwner = new Map<string, { line: number; endLine: number }[]>();
  for (const relType of ["DEFINES_METHOD", "DEFINES_INTERFACE_METHOD"] as const) {
    for (const relationship of graph.relationshipsOfType(relType as GraphRelationship["type"])) {
      const fn = graph.node(relationship.to);
      if (!fn || fn.label !== "Function" || !byId.has(relationship.from)) continue;
      push(functionsByOwner, relationship.from, { line: Number(fn.properties.line), endLine: Number(fn.properties.endLine) });
    }
  }
  // The line of the innermost function of `owner` whose body holds `line` (a local or anonymous class's declaring function).
  const declaringFunctionLine = (type: JavaType): number | null => {
    const owner = enclosing(type);
    if (!owner) return null;
    const line = Number(type.node.properties.line);
    let best: number | null = null;
    for (const fn of functionsByOwner.get(owner.id) ?? []) if (fn.line <= line && line <= fn.endLine && (best === null || fn.line >= best)) best = fn.line;
    return best;
  };
  const localsByName = new Map<string, JavaType[]>();
  for (const type of types) if (type.node.properties.nesting === "local") push(localsByName, type.name, type);

  // A local class is visible only from code lexically inside the method that declares it.
  const resolveLocal = (name: string, current: JavaType, fnLine: number | null): JavaType | null => {
    if (fnLine === null) return null;
    return localsByName.get(name)?.find((local) => local.fileId === current.fileId && local.outer === current.qualifiedName && declaringFunctionLine(local) === fnLine) ?? null;
  };

  const resolveSimple = (name: string, scope: TypeScope): JavaType | null => {
    // The enclosing types, innermost first: the type itself, its member types, then the same for its outer types.
    const own = scope.typeId ? byId.get(scope.typeId) ?? null : null;
    let fnLine: number | null = scope.fnLine ?? null;
    for (let current = own; current; fnLine = declaringFunctionLine(current), current = enclosing(current)) {
      const local = localsByName.has(name) ? resolveLocal(name, current, fnLine) : null;
      if (local) return local;
      if (current.name === name) return current;
      const nested = member(current, name) ?? inheritedMember(current, name, new Set());
      if (nested) return nested;
    }
    const sameFile = byFile.get(scope.fileId)?.find((type) => type.name === name && type.outer === null);
    if (sameFile) return sameFile;
    const imports = importsByFile.get(scope.fileId) ?? [];
    for (const node of imports) {
      if (node.properties.isWildcard === true) continue;
      const source = String(node.properties.source ?? "");
      if (source.split(".").at(-1) === name) {
        const found = byQualifiedName(source, scope.fileId);
        if (found) return found;
      }
    }
    const packageName = packageOfFile(scope.fileId);
    const samePackage = byQualifiedName(packageName === "" ? name : `${packageName}.${name}`, scope.fileId);
    if (samePackage) return samePackage;
    for (const node of imports) {
      if (node.properties.isWildcard !== true) continue;
      const found = byQualifiedName(`${String(node.properties.source ?? "")}.${name}`, scope.fileId);
      if (found) return found;
    }
    return null;
  };

  // A member type inherited from a supertype of `type` (`class A extends B` sees B.Inner as `Inner`).
  const inheritedMember = (type: JavaType, name: string, seen: Set<string>): JavaType | null => {
    if (seen.has(type.id)) return null;
    seen.add(type.id);
    for (const parent of supertypes(type)) {
      const found = member(parent, name) ?? inheritedMember(parent, name, seen);
      if (found) return found;
    }
    return null;
  };

  const resolve = (name: string, scope: TypeScope): JavaType | null => {
    if (name.endsWith("[]") || name === "") return null;
    if (!name.includes(".")) return resolveSimple(name, scope);
    const segments = name.split(".");
    let current = resolveSimple(segments[0]!, scope);
    for (let position = 1; current && position < segments.length; position += 1) current = member(current, segments[position]!) ?? inheritedMember(current, segments[position]!, new Set());
    return current ?? byQualifiedName(name, scope.fileId);
  };

  const supertypeCache = new Map<string, JavaType[]>();
  const supertypes = (type: JavaType): JavaType[] => {
    const known = supertypeCache.get(type.id);
    if (known) return known;
    supertypeCache.set(type.id, []); // a cycle sees nothing
    const scope: TypeScope = { fileId: type.fileId, typeId: type.id };
    // A supertype name is written outside the type's own body: its member types are not in scope.
    const outerScope: TypeScope = { fileId: type.fileId, typeId: type.outer === null ? null : byQualifiedName(type.outer)?.id ?? null };
    const names = type.isInterface
      ? parseStringList(type.node.properties.embeds)
      : [...parseStringList(type.node.properties.extendsNames), ...parseStringList(type.node.properties.implementsNames)];
    const found: JavaType[] = [];
    for (const name of names) {
      const target = resolve(name, type.node.properties.nesting === "anonymous" ? scope : outerScope) ?? resolve(name, scope);
      if (target && target.id !== type.id && !found.includes(target)) found.push(target);
    }
    supertypeCache.set(type.id, found);
    return found;
  };

  let subtypesById: Map<string, JavaType[]> | null = null;
  const subtypes = (type: JavaType): readonly JavaType[] => {
    if (!subtypesById) {
      const direct = new Map<string, JavaType[]>();
      for (const candidate of types) for (const parent of supertypes(candidate)) push(direct, parent.id, candidate);
      subtypesById = new Map();
      for (const root of types) {
        const all: JavaType[] = [];
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

  return { types, byId, byQualifiedName, resolve, enclosing, supertypes, subtypes };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

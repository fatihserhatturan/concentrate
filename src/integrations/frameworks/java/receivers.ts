import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { normalizeJavaType } from "../../languages/java/syntax.js";
import { createJavaTypeIndex, parseStringList, type JavaTypeIndex } from "../../languages/java/types.js";
import { javaMethods } from "./shared.js";

// The declared type of the receiver of a Java call, to tell `jdbcTemplate.query(…)` or
// `restTemplate.getForObject(…)` from an unrelated `query` or `getForObject`.
//
// A receiver is the text the parser keeps on a Call node (`receiver`). What it starts with decides:
//   - a name that is a parameter or a local (`javaLocals` of the Function: explicit types, and
//     `var x = new T(…)` / `var x = (T) y`): its declared type. A local whose type is not known
//     (`var x = f()`) shadows a field of the same name and gives null;
//   - a field of the enclosing type, then of its supertypes, then of the outer types (`this.client`,
//     `client`; constructor-injected `private final` fields are fields): the field's declared type;
//   - `new T(…)` and `((T) x)`: `T`;
//   - `this`: the enclosing type;
//   - a type (`Type`, `Outer.Inner`, `pkg.Type`): the type itself (a static call), and
//     `Type.FIELD` / `a.b` a field of the type of the part before (`Holder.client`, `a.b.c`);
//   - any other expression (a call chain `getClient().get()`, an array element) gives null.
// Types are normalized names as the parser writes them (generic arguments removed, `Map.Entry`).
//
// A type is `qualifiedName` when a scanned type of that name is visible from the file, or the written name
// is qualified, or a single-type import or `java.lang` names it (`JdbcTemplate` imported from
// `org.springframework.jdbc.core`); otherwise null, and `candidates` lists what the wildcard imports of
// the file could make it (`org.springframework.jdbc.core.*` → `org.springframework.jdbc.core.JdbcTemplate`).
// `receiverMatches` answers whether a type may be a given library class: by its own name, or, for a scanned
// type, because a type it extends or implements (through scanned types too) is one of them
// (`class MyRt extends RestTemplate`, `ancestors`).
//
// Two flavours: `createJavaReceiverResolver` over the whole graph (a contributor, after every file is
// parsed: inherited fields and types of other files are known) and `createFileReceiverResolver` over one
// file's nodes (a parse plugin: only types and supertypes of the same file are known).

export type JavaReceiverType = {
  /** The declared type as the parser writes it: `JdbcTemplate`, `Map.Entry`, `org.x.Client`. */
  typeName: string;
  /** Known qualified name, or null. */
  qualifiedName: string | null;
  /** When `qualifiedName` is null: the names the file's wildcard imports could stand for. */
  candidates: string[];
  /** Id of the scanned Class/Interface node when the type is one of the scan. */
  typeId: string | null;
  /** For a scanned type: the qualified names (or wildcard-import candidates) of the external types it extends or implements, transitively. Absent when none or unknown. */
  ancestors?: string[];
  via: "local" | "field" | "new" | "this" | "static";
};

export type JavaReceiverResolver = {
  /** The type of the receiver expression `text` (as a Call node's `receiver` property) used inside `fn`. */
  typeOf(text: string | null | undefined, fn: GraphNode): JavaReceiverType | null;
  /** The receiver type of a Call node; `fn` is needed in a file resolver only when the CALLS relationship is not among its nodes. Null for an unqualified call. */
  typeOfCall(call: GraphNode, fn?: GraphNode): JavaReceiverType | null;
};

type ImportInfo = { source: string; wildcard: boolean };
type TypeRef = { id: string; qualifiedName: string; fileId: string };
type FnContext = { ownerId: string; fileId: string; fnLine: number };

// What the type reading needs of its surroundings; the two resolvers differ only here.
type Env = {
  context(fn: GraphNode): FnContext | null;
  importsOf(fileId: string): readonly ImportInfo[];
  scannedType(name: string, context: FnContext): TypeRef | null;
  typeById(id: string): TypeRef | null;
  /** The normalized declared type of field `name` of the type, its supertypes included; undefined when there is none. */
  fieldType(typeId: string, name: string): string | null | undefined;
  enclosing(typeId: string): string | null;
  /** The external supertypes of a scanned type, as `qualifyExternal` names them; none when unknown. */
  ancestors?(typeId: string): string[];
};

const JAVA_LANG = new Set([
  "Object", "String", "Integer", "Long", "Short", "Byte", "Double", "Float", "Boolean", "Character", "Number",
  "StringBuilder", "StringBuffer", "Math", "System", "Thread", "Runnable", "Class", "Iterable", "CharSequence",
]);

function qualifyExternal(typeName: string, imports: readonly ImportInfo[]): { qualifiedName: string | null; candidates: string[] } {
  if (/^[a-z]/u.test(typeName) && typeName.includes(".")) return { qualifiedName: typeName, candidates: [] };
  const [first, ...rest] = typeName.split(".") as [string, ...string[]];
  const suffix = rest.length > 0 ? `.${rest.join(".")}` : "";
  for (const entry of imports) {
    if (!entry.wildcard && entry.source.split(".").at(-1) === first) return { qualifiedName: `${entry.source}${suffix}`, candidates: [] };
  }
  if (JAVA_LANG.has(first)) return { qualifiedName: `java.lang.${typeName}`, candidates: [] };
  if (!/^[A-Z]/u.test(first)) return { qualifiedName: null, candidates: [] };
  return { qualifiedName: null, candidates: imports.filter((entry) => entry.wildcard).map((entry) => `${entry.source}.${typeName}`) };
}

const PRIMITIVES = new Set(["int", "long", "short", "byte", "char", "boolean", "float", "double", "void"]);

function describe(typeName: string, context: FnContext, env: Env, via: JavaReceiverType["via"]): JavaReceiverType | null {
  if (PRIMITIVES.has(typeName) || typeName.endsWith("[]")) return null;
  const scanned = env.scannedType(typeName, context);
  if (scanned) {
    const ancestors = env.ancestors?.(scanned.id) ?? [];
    return { typeName, qualifiedName: scanned.qualifiedName, candidates: [], typeId: scanned.id, ...(ancestors.length > 0 ? { ancestors } : {}), via };
  }
  return { typeName, ...qualifyExternal(typeName, env.importsOf(context.fileId)), typeId: null, via };
}

function localsOf(fn: GraphNode): Map<string, { type: string } | null> {
  try {
    const parsed = JSON.parse(String(fn.properties.javaLocals ?? "{}")) as Record<string, { type: string } | null>;
    return new Map(Object.entries(parsed));
  } catch {
    return new Map();
  }
}

// The type a field chain ends at: `a.b.c` after the type of `a`.
function followFields(start: JavaReceiverType, fields: readonly string[], context: FnContext, env: Env): JavaReceiverType | null {
  let current: JavaReceiverType | null = start;
  for (const field of fields) {
    if (!current?.typeId) return null;
    const type = env.fieldType(current.typeId, field);
    if (!type) return null;
    const owner = env.typeById(current.typeId);
    if (!owner) return null;
    current = describe(type, { ownerId: owner.id, fileId: owner.fileId, fnLine: 0 }, env, "field");
  }
  return current;
}

// The first closing parenthesis of the argument list that opens at `open`; -1 when it never closes.
function closingParenthesis(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return i;
  }
  return -1;
}

function typeOfText(raw: string, fn: GraphNode, env: Env): JavaReceiverType | null {
  const context = env.context(fn);
  if (!context) return null;
  const text = raw.trim();

  // `new T(…)` as the whole receiver; `new T(…).m()` is a call chain.
  if (text.startsWith("new ")) {
    const open = text.indexOf("(");
    if (open === -1 || closingParenthesis(text, open) !== text.length - 1) return null;
    const type = normalizeJavaType(text.slice(4, open));
    return type ? describe(type, context, env, "new") : null;
  }
  // `((T) x)` and `(T) x`: the cast type; other parentheses are looked through.
  let inner = text;
  while (inner.startsWith("(") && closingParenthesis(inner, 0) === inner.length - 1) inner = inner.slice(1, -1).trim();
  const cast = /^\(\s*([A-Za-z_$][\w$.<>?,\s]*?)\s*\)\s*[\w$.]+$/u.exec(inner);
  if (cast) {
    const type = normalizeJavaType(cast[1]);
    return type ? describe(type, context, env, "local") : null;
  }
  if (inner !== text) return typeOfText(inner, fn, env);
  if (text === "this") {
    const own = env.typeById(context.ownerId);
    return own ? { typeName: own.qualifiedName.split(".").at(-1)!, qualifiedName: own.qualifiedName, candidates: [], typeId: own.id, via: "this" } : null;
  }
  const chain = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.exec(text) ? text.split(".") : null;
  if (!chain) return null;

  // `this.field…`, `Outer.this.field…`
  const thisAt = chain.indexOf("this");
  if (thisAt !== -1) {
    const owner = thisAt === 0 ? context.ownerId : env.scannedType(chain.slice(0, thisAt).join("."), context)?.id;
    const fieldNames = chain.slice(thisAt + 1);
    if (!owner || fieldNames.length === 0) return null;
    const first = fieldOf(owner, fieldNames[0]!, env, false);
    const start = first ? describe(first, context, env, "field") : null;
    return start ? followFields(start, fieldNames.slice(1), context, env) : null;
  }

  const [head, ...rest] = chain as [string, ...string[]];
  // A parameter or local shadows a field.
  const locals = localsOf(fn);
  if (locals.has(head)) {
    const type = locals.get(head)?.type;
    const start = type ? describe(type, context, env, "local") : null;
    return start ? followFields(start, rest, context, env) : null;
  }
  const own = fieldOf(context.ownerId, head, env, true);
  if (own) {
    const start = describe(own, context, env, "field");
    return start ? followFields(start, rest, context, env) : null;
  }
  // A type: the longest prefix of the chain that is one, then fields.
  for (let length = chain.length; length >= 1; length -= 1) {
    const name = chain.slice(0, length).join(".");
    const scanned = env.scannedType(name, context);
    if (scanned) {
      const start: JavaReceiverType = { typeName: name, qualifiedName: scanned.qualifiedName, candidates: [], typeId: scanned.id, via: "static" };
      return followFields(start, chain.slice(length), context, env);
    }
  }
  // An external type written by its simple name (`Executors`, `HttpClient`): a static call.
  if (chain.length === 1 && /^[A-Z]/u.test(head)) {
    const external = describe(head, context, env, "static");
    return external && (external.qualifiedName !== null || external.candidates.length > 0) ? external : null;
  }
  if (/^[a-z]/u.test(head) && chain.length > 1) {
    const last = chain.at(-1)!;
    return /^[A-Z]/u.test(last) ? { typeName: chain.join("."), qualifiedName: chain.join("."), candidates: [], typeId: null, via: "static" } : null;
  }
  return null;
}

// The declared type of field `name` seen from `ownerId`: its own and inherited fields, then (`outer`) those of the enclosing types.
function fieldOf(ownerId: string, name: string, env: Env, outer: boolean): string | null {
  for (let current: string | null = ownerId; current; current = outer ? env.enclosing(current) : null) {
    const type = env.fieldType(current, name);
    if (type) return type;
    if (type === null) return null;
  }
  return null;
}

/** Whether a receiver type may be one of the library classes `names` (qualified): by qualified name, or by a wildcard import that could bring it. */
export function receiverMatches(type: JavaReceiverType | null | undefined, names: readonly string[]): boolean {
  if (!type) return false;
  if (type.ancestors?.some((name) => names.includes(name))) return true;
  if (type.qualifiedName !== null) return names.includes(type.qualifiedName);
  return type.candidates.some((candidate) => names.includes(candidate));
}

function resolverOver(env: Env, callerOf: (call: GraphNode) => GraphNode | undefined): JavaReceiverResolver {
  return {
    typeOf: (text, fn) => (text ? typeOfText(text, fn, env) : null),
    typeOfCall(call, fn) {
      const text = typeof call.properties.receiver === "string" ? call.properties.receiver : null;
      const owner = fn ?? callerOf(call);
      return text && owner ? typeOfText(text, owner, env) : null;
    },
  };
}

// ---------------------------------------------------------------- over the graph

const graphResolvers = new WeakMap<object, JavaReceiverResolver>();

export function createJavaReceiverResolver(graph: IGraphContributor): JavaReceiverResolver {
  const known = graphResolvers.get(graph);
  if (known) return known;
  const index = createResolutionRelationshipIndex(graph);
  const types: JavaTypeIndex = createJavaTypeIndex(graph, index);
  const methods = new Map(javaMethods(graph).map((method) => [method.node.id, method]));
  const fieldsByType = new Map<string, Map<string, GraphNode>>();
  for (const type of ["DEFINES_FIELD", "DEFINES_INTERFACE_FIELD"] as const) {
    for (const relationship of graph.relationshipsOfType(type as GraphRelationship["type"])) {
      const field = graph.node(relationship.to);
      if (!field) continue;
      const own = fieldsByType.get(relationship.from) ?? new Map<string, GraphNode>();
      own.set(String(field.properties.name), field);
      fieldsByType.set(relationship.from, own);
    }
  }
  const importsByFile = new Map<string, ImportInfo[]>();
  for (const relationship of graph.relationshipsOfType("IMPORTS")) {
    const node = graph.node(relationship.to);
    if (!node || node.properties.isStatic === true || typeof node.properties.source !== "string") continue;
    const list = importsByFile.get(relationship.from) ?? [];
    list.push({ source: node.properties.source, wildcard: node.properties.isWildcard === true });
    importsByFile.set(relationship.from, list);
  }
  const callerByCall = new Map<string, GraphNode>();
  for (const relationship of graph.relationshipsOfType("CALLS")) {
    const fn = methods.get(relationship.from)?.node;
    if (fn) callerByCall.set(relationship.to, fn);
  }

  const fieldType = (typeId: string, name: string, seen = new Set<string>()): string | null | undefined => {
    if (seen.has(typeId)) return undefined;
    seen.add(typeId);
    const field = fieldsByType.get(typeId)?.get(name);
    if (field) {
      const typeName = typeof field.properties.typeName === "string" ? field.properties.typeName : null;
      return typeName ?? null;
    }
    const type = types.byId.get(typeId);
    for (const parent of type ? types.supertypes(type) : []) {
      const found = fieldType(parent.id, name, seen);
      if (found !== undefined) return found;
    }
    return undefined;
  };

  const ancestorCache = new Map<string, string[]>();
  const ancestors = (typeId: string): string[] => {
    const known = ancestorCache.get(typeId);
    if (known) return known;
    ancestorCache.set(typeId, []);
    const type = types.byId.get(typeId);
    const found = new Set<string>();
    if (type) {
      const names = type.isInterface
        ? parseStringList(type.node.properties.embeds)
        : [...parseStringList(type.node.properties.extendsNames), ...parseStringList(type.node.properties.implementsNames)];
      const scannedParents = new Set(types.supertypes(type).map((parent) => parent.id));
      for (const name of names) {
        // A name that is a scanned type is followed through its own ancestors; any other is an external type.
        const scope = { fileId: type.fileId, typeId: type.outer === null ? null : types.byQualifiedName(type.outer)?.id ?? null };
        const target = types.resolve(name, scope) ?? types.resolve(name, { fileId: type.fileId, typeId: type.id });
        if (target && scannedParents.has(target.id)) continue;
        const external = qualifyExternal(name, importsByFile.get(type.fileId) ?? []);
        if (external.qualifiedName !== null) found.add(external.qualifiedName);
        for (const candidate of external.candidates) found.add(candidate);
      }
      for (const parent of types.supertypes(type)) for (const inherited of ancestors(parent.id)) found.add(inherited);
    }
    const list = [...found];
    ancestorCache.set(typeId, list);
    return list;
  };

  const env: Env = {
    ancestors,
    context(fn) {
      const method = methods.get(fn.id);
      return method ? { ownerId: method.owner.id, fileId: method.fileId, fnLine: Number(fn.properties.line) } : null;
    },
    importsOf: (fileId) => importsByFile.get(fileId) ?? [],
    scannedType(name, context) {
      const found = types.resolve(name, { fileId: context.fileId, typeId: context.ownerId, fnLine: context.fnLine });
      return found ? { id: found.id, qualifiedName: found.qualifiedName, fileId: found.fileId } : null;
    },
    typeById(id) {
      const found = types.byId.get(id);
      return found ? { id: found.id, qualifiedName: found.qualifiedName, fileId: found.fileId } : null;
    },
    fieldType,
    enclosing(typeId) {
      const type = types.byId.get(typeId);
      return type ? types.enclosing(type)?.id ?? null : null;
    },
  };
  const created = resolverOver(env, (call) => callerByCall.get(call.id));
  graphResolvers.set(graph, created);
  return created;
}

// ---------------------------------------------------------------- over one file (parse time)

/**
 * A resolver for the nodes of one file, for a parse plugin: types and their fields come from the file's
 * own nodes, so a supertype or a type of another file is unknown (a field inherited from it gives null).
 */
export function createFileReceiverResolver(file: { fileNodeId: string; nodes: readonly GraphNode[]; relationships: readonly GraphRelationship[] }): JavaReceiverResolver {
  const owners = new Map<string, GraphNode>();
  const ownerByFunction = new Map<string, string>();
  const callerByCall = new Map<string, GraphNode>();
  const fieldsByType = new Map<string, Map<string, GraphNode>>();
  const typesByQualified = new Map<string, GraphNode>();
  const ids = new Map<string, GraphNode>();
  const imports: ImportInfo[] = [];
  for (const node of file.nodes) {
    if (!node.id.startsWith(`${file.fileNodeId}:`)) continue;
    ids.set(node.id, node);
    if (node.label === "Class" || node.label === "Interface") {
      owners.set(node.id, node);
      typesByQualified.set(String(node.properties.qualifiedName), node);
    } else if (node.label === "Import" && node.properties.isStatic !== true && typeof node.properties.source === "string") {
      imports.push({ source: node.properties.source, wildcard: node.properties.isWildcard === true });
    }
  }
  for (const relationship of file.relationships) {
    if (relationship.type === "DEFINES_METHOD" || (relationship.type as string) === "DEFINES_INTERFACE_METHOD") ownerByFunction.set(relationship.to, relationship.from);
    else if (relationship.type === "CALLS") {
      const fn = ids.get(relationship.from);
      if (fn) callerByCall.set(relationship.to, fn);
    } else if (relationship.type === "DEFINES_FIELD" || (relationship.type as string) === "DEFINES_INTERFACE_FIELD") {
      const field = ids.get(relationship.to);
      if (!field) continue;
      const own = fieldsByType.get(relationship.from) ?? new Map<string, GraphNode>();
      own.set(String(field.properties.name), field);
      fieldsByType.set(relationship.from, own);
    }
  }
  const ref = (node: GraphNode | undefined): TypeRef | null => (node ? { id: node.id, qualifiedName: String(node.properties.qualifiedName), fileId: file.fileNodeId } : null);
  const packageName = String(file.nodes.find((node) => node.id === file.fileNodeId)?.properties.packageName ?? "");
  const outerOf = (id: string): string | null => {
    const outer = owners.get(id)?.properties.outer;
    return typeof outer === "string" ? typesByQualified.get(outer)?.id ?? null : null;
  };

  const env: Env = {
    context(fn) {
      const owner = ownerByFunction.get(fn.id);
      return owner ? { ownerId: owner, fileId: file.fileNodeId, fnLine: Number(fn.properties.line) } : null;
    },
    importsOf: () => imports,
    scannedType(name, context) {
      // Member types of the enclosing types (innermost first), then the file's top-level types.
      for (let current: string | null = context.ownerId; current; current = outerOf(current)) {
        const owner = owners.get(current);
        if (!owner) break;
        if (owner.properties.name === name) return ref(owner);
        const nested = typesByQualified.get(`${owner.properties.qualifiedName}.${name}`);
        if (nested) return ref(nested);
      }
      return ref(typesByQualified.get(packageName === "" ? name : `${packageName}.${name}`) ?? typesByQualified.get(name));
    },
    typeById: (id) => ref(owners.get(id)),
    fieldType(typeId, name) {
      const field = fieldsByType.get(typeId)?.get(name);
      if (!field) return undefined;
      return typeof field.properties.typeName === "string" ? field.properties.typeName : null;
    },
    enclosing: outerOf,
  };
  return resolverOver(env, (call) => callerByCall.get(call.id));
}

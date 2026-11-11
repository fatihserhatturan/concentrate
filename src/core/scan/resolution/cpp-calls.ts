import type { IGraphContributor } from "../../contracts/graph-contributor.js";
import type { GraphNode } from "../../graph/model.js";
import type { ResolutionRelationshipIndex } from "./indexes.js";
import { isCppFile } from "./file-kind.js";

// C and C++ names are visible through `#include`: a file sees what it and the
// files it includes (transitively) declare. A call resolves against those
// declarations by qualified name (`ns::Foo::bar`), and a declaration in a
// header leads to the definition in a source file (DEFINED_BY). A call the
// index cannot place stays unresolved; nothing is guessed from a bare name.

type Scope = {
  namespaces: string[];
  usingNamespaces: string[];
  usingNames: Array<{ name: string }>;
  namespaceAliases: Record<string, string>;
};

export type CppCallTarget = { functionId: string; via?: string };

export type CppIndex = {
  fileByNodeId: Map<string, string>;
  nodesById: Map<string, GraphNode>;
  functionsByQualifiedName: Map<string, GraphNode[]>;
  macrosByName: Map<string, GraphNode[]>;
  classesByQualifiedName: Map<string, GraphNode[]>;
  aliasesByQualifiedName: Map<string, GraphNode[]>;
  variablesByName: Map<string, GraphNode[]>;
  scopeByFile: Map<string, Scope>;
  includesByFile: Map<string, string[]>;
  closures: Map<string, Set<string>>;
  basesByClass: Map<string, string[]>;
  derivedByClass: Map<string, string[]>;
  definitionsByDeclaration: Map<string, string[]>;
  fieldCache: Map<string, Array<{ name: string; type: string | null }>>;
};

const indexes = new WeakMap<object, CppIndex>();

export function cppIndexFor(graph: IGraphContributor, relationshipIndex: ResolutionRelationshipIndex): CppIndex {
  let index = indexes.get(graph);
  if (!index) {
    index = createCppIndex(graph, relationshipIndex);
    indexes.set(graph, index);
  }
  return index;
}

function createCppIndex(graph: IGraphContributor, relationshipIndex: ResolutionRelationshipIndex): CppIndex {
  const index: CppIndex = {
    fileByNodeId: new Map(),
    nodesById: new Map(),
    functionsByQualifiedName: new Map(),
    macrosByName: new Map(),
    classesByQualifiedName: new Map(),
    aliasesByQualifiedName: new Map(),
    variablesByName: new Map(),
    scopeByFile: new Map(),
    includesByFile: new Map(),
    closures: new Map(),
    basesByClass: new Map(),
    derivedByClass: new Map(),
    definitionsByDeclaration: new Map(),
    fieldCache: new Map(),
  };
  const cppFiles = new Set<string>();
  for (const node of graph.nodes) {
    if (node.label !== "File") continue;
    if (node.properties.language !== "c" && node.properties.language !== "cpp") continue;
    cppFiles.add(node.id);
    if (typeof node.properties.cppScope === "string") {
      const parsed = JSON.parse(node.properties.cppScope) as Partial<Scope>;
      index.scopeByFile.set(node.id, { namespaces: [], usingNamespaces: [], usingNames: [], namespaceAliases: {}, ...parsed });
    }
  }
  // Files of the nodes DEFINES_* does not reach through the shared index.
  for (const relationship of graph.relationships) {
    if (relationship.type === "DEFINES_VARIABLE" || relationship.type === "DEFINES_TYPE_ALIAS" || relationship.type === "DEFINES_ENUM") {
      index.fileByNodeId.set(relationship.to, relationship.from);
    }
  }
  const fileOf = (id: string) => relationshipIndex.fileByFunctionId.get(id) ?? relationshipIndex.fileByClassId.get(id) ?? index.fileByNodeId.get(id);
  for (const node of graph.nodes) {
    const file = fileOf(node.id);
    if (!file || !cppFiles.has(file)) continue;
    index.fileByNodeId.set(node.id, file);
    index.nodesById.set(node.id, node);
    const qualified = typeof node.properties.qualifiedName === "string" ? node.properties.qualifiedName : String(node.properties.name);
    if (node.label === "Function") {
      if (node.properties.kind === "macro") push(index.macrosByName, String(node.properties.name), node);
      else if (node.properties.kind !== "test") push(index.functionsByQualifiedName, qualified, node);
    } else if (node.label === "Class") {
      push(index.classesByQualifiedName, qualified, node);
    } else if (node.label === "TypeAlias") {
      push(index.aliasesByQualifiedName, qualified, node);
    } else if (node.label === "Variable") {
      push(index.variablesByName, String(node.properties.name), node);
    }
  }
  for (const relationship of graph.relationships) {
    if (relationship.type === "RESOLVES_TO") {
      const importer = relationshipIndex.fileByImportId.get(relationship.from);
      if (importer && cppFiles.has(importer)) {
        const list = index.includesByFile.get(importer) ?? [];
        list.push(relationship.to);
        index.includesByFile.set(importer, list);
      }
    } else if (relationship.type === "EXTENDS" && index.nodesById.has(relationship.from)) {
      addBase(index, relationship.from, relationship.to);
    } else if (relationship.type === "DEFINED_BY" && index.nodesById.has(relationship.from)) {
      const list = index.definitionsByDeclaration.get(relationship.from) ?? [];
      list.push(relationship.to);
      index.definitionsByDeclaration.set(relationship.from, list);
    }
  }
  return index;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

function addBase(index: CppIndex, derived: string, base: string): void {
  const bases = index.basesByClass.get(derived) ?? [];
  if (!bases.includes(base)) bases.push(base);
  index.basesByClass.set(derived, bases);
  const children = index.derivedByClass.get(base) ?? [];
  if (!children.includes(derived)) children.push(derived);
  index.derivedByClass.set(base, children);
}

// The file and every file it includes, directly or through other headers.
function closureOf(fileId: string, index: CppIndex): Set<string> {
  const cached = index.closures.get(fileId);
  if (cached) return cached;
  const seen = new Set<string>([fileId]);
  const queue = [fileId];
  while (queue.length > 0) {
    for (const next of index.includesByFile.get(queue.shift()!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  index.closures.set(fileId, seen);
  return seen;
}

function scopeChain(scope: string): string[] {
  const parts = scope === "" ? [] : scope.split("::");
  const chain: string[] = [];
  for (let length = parts.length; length >= 0; length -= 1) chain.push(parts.slice(0, length).join("::"));
  return chain;
}

function qualify(scope: string, name: string): string {
  return scope === "" ? name : `${scope}::${name}`;
}

// Where a name written in `scope` of `fileId` may have been declared: the
// enclosing scopes from the innermost out, then the namespaces and names the
// file brings in with `using`.
function candidateNames(name: string, scope: string, fileId: string, index: CppIndex): string[] {
  const fileScope = index.scopeByFile.get(fileId);
  const aliased = (() => {
    const [first, ...rest] = name.split("::");
    const target = fileScope?.namespaceAliases[first!];
    return target ? [target, ...rest].join("::") : name;
  })();
  const names = new Set<string>();
  for (const prefix of scopeChain(scope)) names.add(qualify(prefix, aliased));
  for (const namespace of fileScope?.usingNamespaces ?? []) names.add(qualify(namespace, aliased));
  const first = aliased.split("::")[0]!;
  for (const used of fileScope?.usingNames ?? []) {
    if (used.name.split("::").at(-1) === first) names.add([...used.name.split("::").slice(0, -1), aliased].join("::"));
  }
  return [...names];
}

function resolveClassNode(name: string, scope: string, fileId: string, index: CppIndex, depth = 0): GraphNode | null {
  const visible = closureOf(fileId, index);
  for (const candidate of candidateNames(name.replace(/^::/u, ""), scope, fileId, index)) {
    const found = index.classesByQualifiedName.get(candidate)?.find((node) => visible.has(index.fileByNodeId.get(node.id)!));
    if (found) return found;
    const alias = index.aliasesByQualifiedName.get(candidate)?.find((node) => visible.has(index.fileByNodeId.get(node.id)!));
    if (alias && depth < 3 && typeof alias.properties.aliasOf === "string") {
      const resolved = resolveClassNode(alias.properties.aliasOf, String(alias.properties.namespace ?? ""), index.fileByNodeId.get(alias.id)!, index, depth + 1);
      if (resolved) return resolved;
    }
  }
  return null;
}

// EXTENDS between classes (bases are found through the headers each file
// includes) and DEFINED_BY from a declaration to its definition.
export function addCppRelationships(graph: IGraphContributor, relationshipIndex: ResolutionRelationshipIndex): void {
  const index = cppIndexFor(graph, relationshipIndex);
  if (index.nodesById.size === 0) return;

  for (const node of index.nodesById.values()) {
    if (node.label !== "Class" || typeof node.properties.bases !== "string") continue;
    const fileId = index.fileByNodeId.get(node.id)!;
    for (const base of JSON.parse(node.properties.bases) as Array<{ name: string }>) {
      const target = resolveClassNode(base.name, String(node.properties.namespace ?? ""), fileId, index);
      if (!target || target.id === node.id || index.basesByClass.get(node.id)?.includes(target.id)) continue;
      addBase(index, node.id, target.id);
      graph.addRelationship({ from: node.id, to: target.id, type: "EXTENDS", properties: {} });
    }
  }

  // Definitions by qualified name; a declaration links to those of the same
  // arity (and parameter types when overloaded) in a file that includes its
  // header, or else to the only external definition of the name.
  for (const functions of index.functionsByQualifiedName.values()) {
    const definitions = functions.filter((node) => node.properties.isDeclaration !== true);
    if (definitions.length === 0) continue;
    for (const declaration of functions) {
      if (declaration.properties.isDeclaration !== true) continue;
      const declarationFile = index.fileByNodeId.get(declaration.id)!;
      const sameSignature = definitions.filter((definition) => sameArity(declaration, definition));
      if (sameSignature.length === 0) continue;
      let candidates = sameSignature.length > 1 ? sameSignature.filter((definition) => sameTypes(declaration, definition)) : sameSignature;
      if (candidates.length === 0) candidates = sameSignature;
      const including = candidates.filter((definition) => closureOf(index.fileByNodeId.get(definition.id)!, index).has(declarationFile));
      const linked = including.length > 0 ? including : candidates.filter((definition) => definition.properties.visibility !== "internal");
      if (including.length === 0 && linked.length !== 1) continue;
      for (const definition of linked) {
        graph.addRelationship({ from: declaration.id, to: definition.id, type: "DEFINED_BY", properties: {} });
        const list = index.definitionsByDeclaration.get(declaration.id) ?? [];
        list.push(definition.id);
        index.definitionsByDeclaration.set(declaration.id, list);
      }
    }
  }
}

type Parameter = { name: string | null; type: string | null; optional?: boolean };

function parametersOf(node: GraphNode): Parameter[] {
  try {
    return typeof node.properties.parameters === "string" ? JSON.parse(node.properties.parameters) as Parameter[] : [];
  } catch {
    return [];
  }
}

function sameArity(a: GraphNode, b: GraphNode): boolean {
  return parametersOf(a).length === parametersOf(b).length;
}

function comparableType(type: string | null): string {
  return (type ?? "").replace(/\b(?:const|volatile|struct|class|enum|typename)\b/gu, "").replace(/\s+/gu, "").replace(/^::/u, "");
}

function sameTypes(a: GraphNode, b: GraphNode): boolean {
  const left = parametersOf(a);
  const right = parametersOf(b);
  return left.every((parameter, position) => comparableType(parameter.type) === comparableType(right[position]?.type ?? null));
}

// Whether a call with `count` arguments can run `node`.
function accepts(node: GraphNode, count: number | undefined): boolean {
  if (count === undefined) return true;
  const parameters = parametersOf(node);
  if (parameters.some((parameter) => parameter.type === "...")) return count >= parameters.filter((parameter) => parameter.type !== "...").length - parameters.filter((parameter) => parameter.optional).length;
  const required = parameters.filter((parameter) => !parameter.optional).length;
  return count >= required && count <= parameters.length;
}

type Resolver = {
  index: CppIndex;
  call: GraphNode;
  caller: GraphNode | null;
  fileId: string;
  visible: Set<string>;
  scope: string;
};

export function resolveCppCall(
  call: GraphNode,
  callerFileId: string,
  callerFunctionId: string | undefined,
  index: CppIndex,
): CppCallTarget[] {
  const caller = callerFunctionId ? index.nodesById.get(callerFunctionId) ?? null : null;
  const resolver: Resolver = {
    index,
    call,
    caller,
    fileId: callerFileId,
    visible: closureOf(callerFileId, index),
    scope: caller ? String(caller.properties.namespace ?? "") : "",
  };
  const callee = String(call.properties.callee ?? "");
  const qualifier = typeof call.properties.qualifier === "string" ? call.properties.qualifier : null;
  const receiver = typeof call.properties.receiver === "string" ? call.properties.receiver : null;

  if (receiver !== null) return resolveMemberCall(resolver, callee, receiver);
  if (qualifier !== null) return finish(resolver, lookupQualified(resolver, qualifier, callee), false);
  return resolveFreeCall(resolver, callee);
}

function argumentCount(call: GraphNode): number | undefined {
  return typeof call.properties.argCount === "number" ? call.properties.argCount : undefined;
}

function visibleFunctions(resolver: Resolver, qualifiedName: string): GraphNode[] {
  return (resolver.index.functionsByQualifiedName.get(qualifiedName) ?? []).filter((node) => resolver.visible.has(resolver.index.fileByNodeId.get(node.id)!));
}

function resolveFreeCall(resolver: Resolver, callee: string): CppCallTarget[] {
  const { index } = resolver;
  // A macro is expanded before anything else reads the name.
  const macro = (index.macrosByName.get(callee) ?? []).find((node) => resolver.visible.has(index.fileByNodeId.get(node.id)!));
  if (macro) return [{ functionId: macro.id, via: "macro" }];

  // Inside a class, a bare name is a member (of the class or its bases) first.
  const scopes = scopeChain(resolver.scope);
  for (const scope of scopes) {
    const own = pick(resolver, visibleFunctions(resolver, qualify(scope, callee)));
    if (own.length > 0) return finish(resolver, own, isVirtualContext(resolver, scope));
    const classNode = scope === "" ? null : index.classesByQualifiedName.get(scope)?.[0];
    if (classNode) {
      const inherited = findMembers(resolver, classNode, callee);
      if (inherited.length > 0) return finish(resolver, inherited, true);
    }
  }
  const fileScope = index.scopeByFile.get(resolver.fileId);
  const names: string[] = [];
  for (const namespace of fileScope?.usingNamespaces ?? []) names.push(qualify(namespace, callee));
  for (const used of fileScope?.usingNames ?? []) if (used.name.split("::").at(-1) === callee) names.push(used.name);
  for (const name of names) {
    const found = pick(resolver, visibleFunctions(resolver, name));
    if (found.length > 0) return finish(resolver, found, false);
  }
  return [];
}

function isVirtualContext(resolver: Resolver, scope: string): boolean {
  return scope !== "" && resolver.index.classesByQualifiedName.has(scope);
}

function lookupQualified(resolver: Resolver, qualifier: string, callee: string): GraphNode[] {
  const { index } = resolver;
  if (qualifier === "") return pick(resolver, visibleFunctions(resolver, callee));
  for (const name of candidateNames(`${qualifier}::${callee}`, resolver.scope, resolver.fileId, index)) {
    const found = pick(resolver, visibleFunctions(resolver, name));
    if (found.length > 0) return found;
  }
  // `Derived::inherited()` and `Alias::f()`: the qualifier is a type.
  const classNode = resolveClassNode(qualifier, resolver.scope, resolver.fileId, index);
  return classNode ? findMembers(resolver, classNode, callee) : [];
}

// Candidates the call's argument count allows; none when none does.
function pick(resolver: Resolver, candidates: GraphNode[]): GraphNode[] {
  const count = argumentCount(resolver.call);
  return candidates.filter((node) => accepts(node, count));
}

// `name` among the members of a class, then of its bases.
function findMembers(resolver: Resolver, classNode: GraphNode, name: string, seen = new Set<string>()): GraphNode[] {
  if (seen.has(classNode.id)) return [];
  seen.add(classNode.id);
  const own = pick(resolver, visibleFunctions(resolver, qualify(String(classNode.properties.qualifiedName), name)));
  if (own.length > 0) return own;
  for (const baseId of resolver.index.basesByClass.get(classNode.id) ?? []) {
    const base = resolver.index.nodesById.get(baseId);
    const inherited = base ? findMembers(resolver, base, name, seen) : [];
    if (inherited.length > 0) return inherited;
  }
  return [];
}

type Fields = Array<{ name: string; type: string | null }>;

function fieldsOf(index: CppIndex, classNode: GraphNode): Fields {
  let fields = index.fieldCache.get(classNode.id);
  if (!fields) {
    try {
      fields = typeof classNode.properties.fields === "string" ? JSON.parse(classNode.properties.fields) as Fields : [];
    } catch {
      fields = [];
    }
    index.fieldCache.set(classNode.id, fields);
  }
  return fields;
}

function findFieldType(resolver: Resolver, classNode: GraphNode, name: string, seen = new Set<string>()): string | null {
  if (seen.has(classNode.id)) return null;
  seen.add(classNode.id);
  const field = fieldsOf(resolver.index, classNode).find((candidate) => candidate.name === name);
  if (field) return field.type;
  for (const baseId of resolver.index.basesByClass.get(classNode.id) ?? []) {
    const base = resolver.index.nodesById.get(baseId);
    const found = base ? findFieldType(resolver, base, name, seen) : null;
    if (found) return found;
  }
  return null;
}

function callerClass(resolver: Resolver): GraphNode | null {
  const className = resolver.caller?.properties.className;
  if (typeof className !== "string") return null;
  const scope = String(resolver.caller!.properties.namespace ?? "");
  return resolver.index.classesByQualifiedName.get(scope)?.[0] ?? resolveClassNode(className, scope, resolver.fileId, resolver.index);
}

// The class a function's call yields: the return type of the function the
// name resolves to, or the class of that name (a constructor call).
function resultClass(resolver: Resolver, name: string): GraphNode | null {
  const asClass = resolveClassNode(name, resolver.scope, resolver.fileId, resolver.index);
  if (asClass) return asClass;
  const parts = name.split("::");
  const callee = parts.pop()!;
  const found = parts.length > 0 ? lookupQualified(resolver, parts.join("::"), callee) : resolveFreeCall(resolver, callee).flatMap((target) => resolver.index.nodesById.get(target.functionId) ?? []);
  const returnType = found.find((node) => typeof node.properties.returnType === "string")?.properties.returnType;
  return typeof returnType === "string" ? resolveClassNode(returnType, resolver.scope, resolver.fileId, resolver.index) : null;
}

function receiverClass(resolver: Resolver, receiver: string): GraphNode | null {
  const { index, call } = resolver;
  const [root, ...rest] = receiver.split(".");
  let current: GraphNode | null = null;
  let remaining = rest;
  const constructorName = typeof call.properties.receiverConstructor === "string" ? call.properties.receiverConstructor : null;
  if (root === "this") {
    current = callerClass(resolver);
  } else if (/\(\)$/u.test(constructorName ?? "") && !/^[\w:]+$/u.test(root!)) {
    current = resultClass(resolver, constructorName!.slice(0, -2));
    remaining = [];
  } else if (typeof call.properties.receiverType === "string") {
    current = resolveClassNode(call.properties.receiverType, resolver.scope, resolver.fileId, index);
  } else if (constructorName !== null) {
    current = resultClass(resolver, constructorName.replace(/\(\)$/u, ""));
  } else if (call.properties.receiverIsLocal !== true) {
    // An implicit member (`items_.push()`), then a global variable.
    const owner = callerClass(resolver);
    const fieldType = owner ? findFieldType(resolver, owner, root!) : null;
    const variable = fieldType ? null : (index.variablesByName.get(root!) ?? []).find((node) => resolver.visible.has(index.fileByNodeId.get(node.id)!) && typeof node.properties.typeName === "string");
    const typeName = fieldType ?? (variable ? String(variable.properties.typeName) : null);
    current = typeName ? resolveClassNode(typeName, resolver.scope, resolver.fileId, index) : null;
  }
  for (const field of remaining) {
    if (!current) return null;
    const type = findFieldType(resolver, current, field);
    current = type ? resolveClassNode(type, String(current.properties.qualifiedName), resolver.fileId, index) : null;
  }
  return current;
}

function resolveMemberCall(resolver: Resolver, callee: string, receiver: string): CppCallTarget[] {
  const classNode = receiverClass(resolver, receiver);
  if (!classNode) return [];
  return finish(resolver, findMembers(resolver, classNode, callee), true);
}

// Turns the functions a name reached into targets: a declaration leads to its
// definitions (marked `header`), a virtual member to the base and to every
// override (`virtual`, `override`), an ambiguous overload to each candidate.
function finish(resolver: Resolver, functions: GraphNode[], member: boolean): CppCallTarget[] {
  const { index } = resolver;
  const targets = new Map<string, CppCallTarget>();
  // Overloads of one arity are ambiguous only when they end at different definitions.
  const ambiguous = new Set(functions.flatMap((node) => (node.properties.isDeclaration === true ? index.definitionsByDeclaration.get(node.id) : undefined) ?? [node.id])).size > 1;
  const add = (node: GraphNode, via?: string) => {
    if (!targets.has(node.id)) targets.set(node.id, via ? { functionId: node.id, via } : { functionId: node.id });
  };
  const definitionsOf = (node: GraphNode): Array<{ node: GraphNode; viaHeader: boolean }> => {
    const ids = node.properties.isDeclaration === true ? index.definitionsByDeclaration.get(node.id) ?? [] : [];
    const defined = ids.flatMap((id) => index.nodesById.get(id) ?? []);
    return defined.length > 0 ? defined.map((definition) => ({ node: definition, viaHeader: true })) : [{ node, viaHeader: false }];
  };
  for (const function_ of functions) {
    const isVirtual = member && function_.properties.isVirtual === true;
    for (const { node, viaHeader } of definitionsOf(function_)) {
      add(node, isVirtual ? "virtual" : ambiguous ? "overload" : viaHeader ? "header" : node.properties.isDeclaration === true ? "declaration" : undefined);
    }
    if (!isVirtual) continue;
    // The call may run any override below the class.
    const className = String(function_.properties.className ?? "");
    const owner = index.classesByQualifiedName.get(String(function_.properties.namespace ?? ""))?.[0];
    if (!owner || !className) continue;
    const seen = new Set<string>([owner.id]);
    const queue = [...index.derivedByClass.get(owner.id) ?? []];
    while (queue.length > 0) {
      const derivedId = queue.shift()!;
      if (seen.has(derivedId)) continue;
      seen.add(derivedId);
      queue.push(...index.derivedByClass.get(derivedId) ?? []);
      const derived = index.nodesById.get(derivedId);
      if (!derived) continue;
      const arity = parametersOf(function_).length;
      for (const candidate of index.functionsByQualifiedName.get(qualify(String(derived.properties.qualifiedName), String(function_.properties.name))) ?? []) {
        if (parametersOf(candidate).length !== arity) continue;
        for (const { node } of definitionsOf(candidate)) add(node, "override");
      }
    }
  }
  return [...targets.values()];
}

export { isCppFile };

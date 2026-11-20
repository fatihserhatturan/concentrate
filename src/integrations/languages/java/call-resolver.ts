import type { CallResolutionSession, ResolvedCallTarget } from "../../../core/contracts/call-resolver.js";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { isJavaFile } from "../file-kind.js";
import { normalizeJavaType } from "./syntax.js";
import { createJavaTypeIndex, parseStringList, type JavaType } from "./types.js";

// Java calls. A call reaches the declarations it names through what is known
// of the receiver:
//   foo()              a method of the enclosing types (own or inherited), then static imports
//   Type.m(), pkg.Type.m(), Outer.this.m()   a method of that type
//   x.m()              x is a local or parameter (declared or `var x = new T()`), a field of the
//                      owning type or its supertypes, `this`, `super`, `new T()`, or a chain of
//                      those through fields and the return types of methods
//   new T(..), this(..), super(..), T::new   the constructors of T with that argument count
//   Foo::bar, this::bar                      the methods called bar (arity unknown)
//
// How a target is marked:
//   (no via)    the one method the receiver's type has for that name and argument count
//   "override"  the method also runs when the receiver is a subtype that overrides or implements it
//               (a call to an interface, abstract or overridable method)
//   "overload"  several methods fit the name and argument count: each is a candidate, none is guessed
// A receiver of a type outside the scan (JDK, third party), an unknown method, a
// class with no explicit constructor (there is no Function to point at) and
// anything that cannot be typed stay unresolved; a name is never looked up
// across the repository.

type Param = { name: string; type: string; varargs?: boolean };
type Candidate = { fn: GraphNode; owner: JavaType };
type Value = { type: JavaType; isType: boolean; exact?: boolean; superRef?: boolean };
type Scope = {
  call: GraphNode;
  fileId: string;
  type: JavaType;
  fn: GraphNode | undefined;
  locals: Map<string, { type: string } | null>;
};
type Segment =
  | { kind: "name"; name: string }
  | { kind: "call"; name: string; argCount: number }
  | { kind: "new"; typeName: string; argCount: number };

const unknownType = "\0";

export function createJavaCallSession(graph: IGraphContributor, index: ResolutionRelationshipIndex): CallResolutionSession {
  const types = createJavaTypeIndex(graph, index);
  const methodsByOwner = new Map<string, GraphNode[]>();
  const ownerByFunction = new Map<string, string>();
  const fieldsByOwner = new Map<string, Map<string, GraphNode>>();
  const importsByFile = new Map<string, GraphNode[]>();

  const relationships = (type: string): readonly GraphRelationship[] => graph.relationshipsOfType(type as GraphRelationship["type"]);
  for (const type of ["DEFINES_METHOD", "DEFINES_INTERFACE_METHOD"]) {
    for (const relationship of relationships(type)) {
      const fn = graph.node(relationship.to);
      if (!fn || fn.label !== "Function" || !types.byId.has(relationship.from)) continue;
      ownerByFunction.set(fn.id, relationship.from);
      const list = methodsByOwner.get(relationship.from);
      if (list) list.push(fn);
      else methodsByOwner.set(relationship.from, [fn]);
    }
  }
  for (const type of ["DEFINES_FIELD", "DEFINES_INTERFACE_FIELD"]) {
    for (const relationship of relationships(type)) {
      const field = graph.node(relationship.to);
      if (!field || field.label !== "Field" || !types.byId.has(relationship.from)) continue;
      let fields = fieldsByOwner.get(relationship.from);
      if (!fields) fieldsByOwner.set(relationship.from, fields = new Map());
      if (!fields.has(String(field.properties.name))) fields.set(String(field.properties.name), field);
    }
  }
  for (const node of graph.nodesWithLabel("Import")) {
    const fileId = index.fileByImportId.get(node.id);
    if (!fileId || !isJavaFile(fileId)) continue;
    const list = importsByFile.get(fileId);
    if (list) list.push(node);
    else importsByFile.set(fileId, [node]);
  }

  const paramsCache = new Map<string, Param[]>();
  const paramsOf = (fn: GraphNode): Param[] => {
    let params = paramsCache.get(fn.id);
    if (!params) {
      params = [];
      try {
        const parsed = typeof fn.properties.parameters === "string" ? JSON.parse(fn.properties.parameters) : [];
        if (Array.isArray(parsed)) params = parsed.filter((item): item is Param => typeof item?.type === "string");
      } catch {
        params = [];
      }
      paramsCache.set(fn.id, params);
    }
    return params;
  };
  const localsCache = new Map<string, Scope["locals"]>();
  const localsOf = (fn: GraphNode | undefined): Scope["locals"] => {
    if (!fn) return new Map();
    let locals = localsCache.get(fn.id);
    if (!locals) {
      locals = new Map();
      try {
        const parsed = typeof fn.properties.javaLocals === "string" ? JSON.parse(fn.properties.javaLocals) : {};
        for (const [name, value] of Object.entries(parsed as Record<string, { type?: unknown } | null>)) locals.set(name, value && typeof value.type === "string" ? { type: value.type } : null);
      } catch {
        locals = new Map();
      }
      localsCache.set(fn.id, locals);
    }
    return locals;
  };

  // Type variables in scope (`T`, `E extends Comparable<E>`): a name that is one is not a class of the scan.
  const typeVariables = (owner: JavaType, fn?: GraphNode): Set<string> => {
    const names = new Set<string>();
    const add = (node: GraphNode | undefined) => {
      for (const written of parseStringList(node?.properties.typeParameters)) {
        const name = /^[A-Za-z_$][\w$]*/u.exec(written)?.[0];
        if (name) names.add(name);
      }
    };
    add(fn);
    for (let current: JavaType | null = owner; current; current = types.enclosing(current)) add(current.node);
    return names;
  };

  const typeOfName = (written: string | null | undefined, owner: JavaType, fn?: GraphNode): JavaType | null => {
    const name = normalizeJavaType(written);
    if (!name || name.endsWith("[]")) return null;
    if (!name.includes(".") && typeVariables(owner, fn).has(name)) return null;
    return types.resolve(name, { fileId: owner.fileId, typeId: owner.id });
  };

  const norm = (text: string): string => normalizeJavaType(text) ?? unknownType;

  const accepts = (fn: GraphNode, arity: number | undefined): boolean => {
    if (arity === undefined) return true;
    const params = paramsOf(fn);
    if (params.length > 0 && params[params.length - 1]!.varargs) return arity >= params.length - 1;
    return arity === params.length;
  };

  // `sub` replaces `sup` when a subtype redeclares it: same name and parameter count, and each
  // parameter type equal or (where the supertype wrote a type variable) anything.
  const overrides = (sub: GraphNode, subOwner: JavaType, sup: GraphNode, supOwner: JavaType): boolean => {
    if (sub.properties.name !== sup.properties.name || sub.properties.isStatic === true || sup.properties.isStatic === true) return false;
    const subParams = paramsOf(sub);
    const supParams = paramsOf(sup);
    if (subParams.length !== supParams.length) return false;
    const supVariables = typeVariables(supOwner, sup);
    const subVariables = typeVariables(subOwner, sub);
    return supParams.every((param, position) => {
      const left = norm(subParams[position]!.type);
      const right = norm(param.type);
      return left === right || supVariables.has(right) || subVariables.has(left);
    });
  };

  // The methods called `name` that fit `arity` on a type and its supertypes, nearest first, without the ones a nearer declaration overrides.
  const findMethods = (start: JavaType, name: string, arity: number | undefined): Candidate[] => {
    const found: Candidate[] = [];
    const seen = new Set<string>();
    const queue: JavaType[] = [start];
    while (queue.length > 0) {
      const type = queue.shift()!;
      if (seen.has(type.id)) continue;
      seen.add(type.id);
      for (const fn of methodsByOwner.get(type.id) ?? []) {
        if (fn.properties.kind !== "method" || fn.properties.name !== name || !accepts(fn, arity)) continue;
        if (found.some((other) => other.owner.id !== type.id && overrides(other.fn, other.owner, fn, type))) continue;
        found.push({ fn, owner: type });
      }
      queue.push(...types.supertypes(type));
    }
    return found;
  };

  const findField = (start: JavaType, name: string): { field: GraphNode; owner: JavaType } | null => {
    const seen = new Set<string>();
    const queue: JavaType[] = [start];
    while (queue.length > 0) {
      const type = queue.shift()!;
      if (seen.has(type.id)) continue;
      seen.add(type.id);
      const field = fieldsByOwner.get(type.id)?.get(name);
      if (field) return { field, owner: type };
      queue.push(...types.supertypes(type));
    }
    return null;
  };

  const findFieldInScope = (scope: Scope, name: string) => {
    for (let current: JavaType | null = scope.type; current; current = types.enclosing(current)) {
      const found = findField(current, name);
      if (found) return found;
    }
    return null;
  };

  const valueOfField = (found: { field: GraphNode; owner: JavaType }): Value | null => {
    const type = typeOfName(String(found.field.properties.typeName ?? ""), found.owner);
    return type ? { type, isType: false } : null;
  };

  // The value a call yields, when every candidate agrees on its return type.
  const resultOf = (candidates: Candidate[]): Value | null => {
    let result: JavaType | null = null;
    for (const { fn, owner } of candidates) {
      const type = typeOfName(typeof fn.properties.returnType === "string" ? fn.properties.returnType : null, owner, fn);
      if (!type || (result && result.id !== type.id)) return null;
      result = type;
    }
    return result ? { type: result, isType: false } : null;
  };

  const superclassOf = (type: JavaType): JavaType | null => types.supertypes(type).find((candidate) => !candidate.isInterface) ?? null;

  // Static imports that bring `name` into scope as a method, as (type, candidates).
  const staticImported = (scope: Scope, name: string, arity: number | undefined): { type: JavaType; candidates: Candidate[] } | null => {
    for (const node of importsByFile.get(scope.fileId) ?? []) {
      if (node.properties.isStatic !== true) continue;
      const source = String(node.properties.source ?? "");
      const wildcard = node.properties.isWildcard === true;
      if (!wildcard && source.split(".").at(-1) !== name) continue;
      const type = types.byQualifiedName(wildcard ? source : source.slice(0, Math.max(0, source.lastIndexOf("."))));
      if (!type) continue;
      const candidates = findMethods(type, name, arity).filter((candidate) => candidate.fn.properties.isStatic === true);
      if (candidates.length > 0) return { type, candidates };
    }
    return null;
  };

  // A method named without a receiver: of the enclosing types (innermost first), then imported statically.
  const bareMethods = (scope: Scope, name: string, arity: number | undefined): { value: Value; candidates: Candidate[] } | null => {
    for (let current: JavaType | null = scope.type; current; current = types.enclosing(current)) {
      const candidates = findMethods(current, name, arity);
      if (candidates.length > 0) return { value: { type: current, isType: false }, candidates };
    }
    const imported = staticImported(scope, name, arity);
    return imported ? { value: { type: imported.type, isType: true }, candidates: imported.candidates } : null;
  };

  // The type or value an expression (a receiver) stands for, or null when it cannot be typed.
  const evaluate = (text: string, scope: Scope): Value | null => {
    const segments = splitChain(text);
    if (!segments || segments.length === 0) return null;
    const first = segments[0]!;
    let current: Value | null = null;
    let position = 1;
    if (first.kind === "new") {
      const type = typeOfName(first.typeName, scope.type, scope.fn);
      if (!type) return null;
      current = { type, isType: false, exact: true };
    } else if (first.kind === "call") {
      const found = bareMethods(scope, first.name, first.argCount);
      current = found ? resultOf(found.candidates) : null;
    } else if (first.name === "this") {
      current = { type: scope.type, isType: false };
    } else if (first.name === "super") {
      const parent = superclassOf(scope.type);
      current = parent ? { type: parent, isType: false, superRef: true } : null;
    } else if (scope.locals.has(first.name)) {
      const type = typeOfName(scope.locals.get(first.name)?.type, scope.type, scope.fn);
      current = type ? { type, isType: false } : null;
    } else {
      const field = findFieldInScope(scope, first.name);
      if (field) {
        current = valueOfField(field);
      } else {
        const type = types.resolve(first.name, { fileId: scope.fileId, typeId: scope.type.id });
        if (type) {
          current = { type, isType: true };
        } else {
          // `com.acme.Type`: the leading names are a package.
          let written = first.name;
          for (let next = 1; next < segments.length && segments[next]!.kind === "name"; next += 1) {
            written += `.${(segments[next] as { name: string }).name}`;
            const qualified = types.byQualifiedName(written);
            if (qualified) {
              current = { type: qualified, isType: true };
              position = next + 1;
              break;
            }
          }
        }
      }
    }
    for (; position < segments.length; position += 1) {
      if (!current) return null;
      const segment = segments[position]!;
      if (segment.kind === "call") {
        current = resultOf(findMethods(current.type, segment.name, segment.argCount));
      } else if (segment.kind === "name") {
        if (segment.name === "this" && current.isType) {
          current = { type: current.type, isType: false };
        } else if (segment.name === "super" && current.isType) {
          current = { type: current.type, isType: false, exact: true, superRef: true };
        } else {
          const nested = current.isType ? types.byQualifiedName(`${current.type.qualifiedName}.${segment.name}`) : null;
          const field: ReturnType<typeof findField> = nested ? null : findField(current.type, segment.name);
          current = nested ? { type: nested, isType: true } : field ? valueOfField(field) : null;
        }
      } else {
        return null;
      }
    }
    return current;
  };

  const dispatchTargets = (candidate: Candidate, receiver: Value, add: (fn: GraphNode, via?: string) => void): void => {
    const { fn, owner } = candidate;
    if (receiver.exact || receiver.superRef || receiver.isType || fn.properties.isStatic === true || fn.properties.visibility === "private") return;
    const arity = paramsOf(fn).length;
    for (const subtype of types.subtypes(receiver.type)) {
      for (const other of findMethods(subtype, String(fn.properties.name), arity)) {
        if (other.owner.id === owner.id || other.fn.id === fn.id) continue;
        if (overrides(other.fn, other.owner, fn, owner)) add(other.fn, "override");
      }
    }
  };

  // The targets of a method reached on `receiver`: the method itself, and the overrides below it.
  const toTargets = (candidates: Candidate[], receiver: Value | null): ResolvedCallTarget[] => {
    const targets = new Map<string, ResolvedCallTarget>();
    const add = (fn: GraphNode, via?: string) => {
      if (!targets.has(fn.id)) targets.set(fn.id, via ? { functionId: fn.id, via } : { functionId: fn.id });
    };
    if (candidates.length > 1) {
      for (const candidate of candidates) add(candidate.fn, "overload");
    } else if (candidates.length === 1) {
      add(candidates[0]!.fn);
      if (receiver) dispatchTargets(candidates[0]!, receiver, add);
    }
    return [...targets.values()];
  };

  const constructorsOf = (type: JavaType | null, arity: number | undefined): ResolvedCallTarget[] => {
    if (!type || type.isInterface) return [];
    const constructors = (methodsByOwner.get(type.id) ?? []).filter((fn) => fn.properties.kind === "constructor" && accepts(fn, arity));
    return constructors.map((fn) => (constructors.length > 1 ? { functionId: fn.id, via: "overload" } : { functionId: fn.id }));
  };

  const methodsOn = (value: Value | null, name: string, arity: number | undefined, preferStatic: boolean): ResolvedCallTarget[] => {
    if (!value) return [];
    let candidates = findMethods(value.type, name, arity);
    if (preferStatic && value.isType && candidates.some((candidate) => candidate.fn.properties.isStatic === true)) {
      candidates = candidates.filter((candidate) => candidate.fn.properties.isStatic === true);
    }
    return toTargets(candidates, value);
  };

  return (call, callerFileId, callerFunctionId) => {
    const fn = callerFunctionId ? graph.node(callerFunctionId) : undefined;
    const ownerId = callerFunctionId ? ownerByFunction.get(callerFunctionId) : undefined;
    const owner = ownerId ? types.byId.get(ownerId) : undefined;
    if (!owner) return [];
    const scope: Scope = { call, fileId: callerFileId, type: owner, fn, locals: localsOf(fn) };
    const callee = typeof call.properties.callee === "string" ? call.properties.callee : "";
    const receiver = typeof call.properties.receiver === "string" ? call.properties.receiver : null;
    const arity = typeof call.properties.argumentCount === "number" ? call.properties.argumentCount : undefined;
    switch (call.properties.callKind) {
      case "method": {
        if (receiver === null) {
          const found = bareMethods(scope, callee, arity);
          return found ? toTargets(found.candidates, found.value) : [];
        }
        return methodsOn(evaluate(receiver, scope), callee, arity, true);
      }
      case "methodReference":
        return receiver === null ? [] : methodsOn(evaluate(receiver, scope), callee, undefined, false);
      case "constructorReference": {
        const value = receiver === null ? null : evaluate(receiver, scope);
        return value?.isType ? constructorsOf(value.type, undefined) : [];
      }
      case "explicitConstructor":
        return constructorsOf(callee === "super" ? superclassOf(owner) : owner, arity);
      case "constructor": {
        const qualifier = typeof call.properties.qualifier === "string" ? call.properties.qualifier : null;
        let type: JavaType | null = null;
        if (typeof call.properties.receiverType === "string") type = types.byQualifiedName(call.properties.receiverType);
        if (!type && receiver !== null) {
          const outer = evaluate(receiver, scope);
          if (outer) type = types.byQualifiedName(`${outer.type.qualifiedName}.${callee}`) ?? types.resolve(callee, { fileId: outer.type.fileId, typeId: outer.type.id });
        }
        if (!type) type = types.resolve(qualifier ? `${qualifier}.${callee}` : callee, { fileId: callerFileId, typeId: owner.id });
        return constructorsOf(type, arity);
      }
      default:
        return [];
    }
  };
}

// `a.b(x).c` as its parts; null for anything else (indexing, casts, literals).
function splitChain(text: string): Segment[] | null {
  const segments: Segment[] = [];
  let position = 0;
  while (position < text.length) {
    if (text.startsWith("new ", position)) {
      let end = position + 4;
      let depth = 0;
      while (end < text.length && (depth > 0 || text[end] !== "(")) {
        if (text[end] === "<") depth += 1;
        else if (text[end] === ">") depth -= 1;
        end += 1;
      }
      const typeName = normalizeJavaType(text.slice(position + 4, end));
      const close = matching(text, end);
      if (!typeName || close < 0) return null;
      segments.push({ kind: "new", typeName, argCount: countArguments(text.slice(end + 1, close)) });
      position = close + 1;
    } else {
      const name = /^[A-Za-z_$][\w$]*/u.exec(text.slice(position))?.[0];
      if (!name) return null;
      position += name.length;
      if (text[position] === "(") {
        const close = matching(text, position);
        if (close < 0) return null;
        segments.push({ kind: "call", name, argCount: countArguments(text.slice(position + 1, close)) });
        position = close + 1;
      } else {
        segments.push({ kind: "name", name });
      }
    }
    if (position < text.length) {
      if (text[position] !== ".") return null;
      position += 1;
    }
  }
  return segments;
}

// The index of the `)` that closes the `(` at `open`, or -1.
function matching(text: string, open: number): number {
  let depth = 0;
  let quote: string | null = null;
  for (let position = open; position < text.length; position += 1) {
    const char = text[position]!;
    if (quote) {
      if (char === "\\") position += 1;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) return position;
    }
  }
  return -1;
}

function countArguments(text: string): number {
  if (text.trim() === "") return 0;
  let count = 1;
  let depth = 0;
  let quote: string | null = null;
  for (let position = 0; position < text.length; position += 1) {
    const char = text[position]!;
    if (quote) {
      if (char === "\\") position += 1;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      count += 1;
    }
  }
  return count;
}

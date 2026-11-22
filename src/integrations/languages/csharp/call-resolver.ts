import type { CallResolutionSession, ResolvedCallTarget } from "../../../core/contracts/call-resolver.js";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { isCSharpFile } from "../file-kind.js";
import { canonicalExternalType, externalSupertypes, isTypeVariableName, splitChain, type Segment } from "./receiver-chain.js";
import { normalizeCSharpType, trailingArity, trailingGenericArguments } from "./syntax.js";
import { createCSharpTypeIndex, parseJsonList, typeParameterNames, type CSharpType, type CSharpTypeScope } from "./types.js";

// C# calls. A call reaches the declarations it names through what is known of the receiver:
//   Foo()               a method of the enclosing types (own or inherited), then `using static` types
//   Type.M(), Ns.Type.M(), Alias.M()   a method of that type
//   x.M()               x is a local or parameter (declared, `var x = new T()`, cast, `as`), a field or
//                       property of the owning type or its supertypes, `this`, `base`, `new T()`, a literal,
//                       or a chain of those through fields, properties and the return types of methods
//   new T(..), this(..), base(..)   the constructors of T with that argument count
//   x.Ext(a)            an extension method (`this T x`, static, in a static class whose namespace is in scope)
//                       when `x` has no instance method of that name; `Ext.M(x, a)` is an ordinary static call
//
// How a target is marked:
//   (no via)    the one method the receiver's type has for that name and argument count
//   "override"  the method also runs when the receiver is a subtype that overrides or implements it
//               (a call to an interface, abstract, virtual or overridable method)
//   "overload"  several methods fit the name and argument count: each is a candidate, none is guessed
// A receiver of a type outside the scan (System, third party), an unknown method, a class with no explicit
// constructor (there is no Function to point at) and anything that cannot be typed stay unresolved; a name is
// never looked up across the repository.

type Param = { name: string; type: string; modifier?: string; params?: boolean; optional?: boolean };
type Candidate = { fn: GraphNode; owner: CSharpType };
// What an expression is: a type of the scan (`type`), a type outside it (`ext`, normalised: `string`, `List`), with
// the generic arguments it was written with. `isType`: the expression names the type itself (static access).
type Value = { type: CSharpType | null; ext: string | null; isType: boolean; exact?: boolean; superRef?: boolean; args?: Array<Value | null> };
type Local = { type?: string; fullType?: string; initializer?: string } | null;
type Scope = {
  call: GraphNode;
  fileId: string;
  type: CSharpType | null;
  namespace: string;
  fn: GraphNode | undefined;
  locals: Map<string, Local>;
  /** The line of the caller, which tells the namespace blocks of a file apart. */
  line: number | undefined;
  /** Locals whose initializer is being typed (a cycle `var a = b; var b = a;` types nothing). */
  resolving: Set<string>;
};
type Context = { fileId: string; type: CSharpType | null; namespace: string; fn?: GraphNode | undefined; line?: number | undefined };
const primitiveTypes: ReadonlySet<string> = new Set(["int", "long", "double", "float", "decimal", "bool", "char", "short", "byte", "sbyte", "uint", "ulong", "ushort"]);

export function createCSharpCallSession(graph: IGraphContributor, index: ResolutionRelationshipIndex): CallResolutionSession {
  const types = createCSharpTypeIndex(graph, index);
  const methodsByOwner = new Map<string, GraphNode[]>();
  const ownerByFunction = new Map<string, string>();
  const fieldsByOwner = new Map<string, Map<string, GraphNode>>();
  const extensionsByName = new Map<string, Candidate[]>();

  const relationships = (type: string): readonly GraphRelationship[] => graph.relationshipsOfType(type as GraphRelationship["type"]);
  for (const type of ["DEFINES_METHOD", "DEFINES_INTERFACE_METHOD"]) {
    for (const relationship of relationships(type)) {
      const fn = graph.node(relationship.to);
      const owner = types.byId.get(relationship.from);
      if (!fn || fn.label !== "Function" || !owner) continue;
      ownerByFunction.set(fn.id, relationship.from);
      const list = methodsByOwner.get(relationship.from);
      if (list) list.push(fn);
      else methodsByOwner.set(relationship.from, [fn]);
      if (fn.properties.isExtension === true && fn.properties.kind === "method" && fn.properties.isStatic === true) {
        const named = extensionsByName.get(String(fn.properties.name));
        if (named) named.push({ fn, owner });
        else extensionsByName.set(String(fn.properties.name), [{ fn, owner }]);
      }
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

  // The file a member is written in: `file:<path>:function:...`. A `partial` type spans files, so the owner's own file is not it.
  const fileOfMember = (node: GraphNode | undefined, owner: CSharpType | null): string | null => {
    const written = node ? /^(file:.*?):(?:function|field):/u.exec(node.id)?.[1] : undefined;
    return written ?? owner?.fileIds[0] ?? null;
  };
  const lineOf = (member: GraphNode | undefined, owner: CSharpType | null): number | undefined => {
    if (typeof member?.properties.line === "number") return member.properties.line;
    // A type declared in one file only has one declaration line (a `partial` one has several).
    return !member && owner && owner.fileIds.length === 1 && typeof owner.node.properties.line === "number" ? owner.node.properties.line : undefined;
  };
  const contextOf = (owner: CSharpType, member?: GraphNode): Context => ({ fileId: fileOfMember(member, owner) ?? owner.fileIds[0]!, type: owner, namespace: owner.namespace, fn: member, line: lineOf(member, owner) });
  const scopeOfContext = (context: Context): CSharpTypeScope => ({ fileId: context.fileId, typeId: context.type?.id ?? null, namespace: context.namespace, ...(context.line === undefined ? {} : { line: context.line }) });

  const paramsCache = new Map<string, Param[]>();
  const paramsOf = (fn: GraphNode): Param[] => {
    let params = paramsCache.get(fn.id);
    if (!params) {
      params = parseJsonList<Param>(fn.properties.parameters).filter((item) => typeof item?.type === "string");
      paramsCache.set(fn.id, params);
    }
    return params;
  };
  const localsCache = new Map<string, Map<string, Local>>();
  const localsOf = (fn: GraphNode | undefined): Map<string, Local> => {
    if (!fn) return new Map();
    let locals = localsCache.get(fn.id);
    if (!locals) {
      locals = new Map();
      try {
        const parsed = typeof fn.properties.csharpLocals === "string" ? JSON.parse(fn.properties.csharpLocals) : {};
        for (const [name, value] of Object.entries(parsed as Record<string, { type?: unknown; fullType?: unknown; initializer?: unknown } | null>)) {
          if (value && typeof value.type === "string") locals.set(name, typeof value.fullType === "string" ? { type: value.type, fullType: value.fullType } : { type: value.type });
          else if (value && typeof value.initializer === "string") locals.set(name, { initializer: value.initializer });
          else locals.set(name, null);
        }
      } catch {
        locals = new Map();
      }
      localsCache.set(fn.id, locals);
    }
    return locals;
  };

  // Type variables in scope (`T`): a name that is one is not a type of the scan.
  const typeVariables = (owner: CSharpType | null, fn?: GraphNode): Set<string> => {
    const names = new Set<string>();
    if (fn) for (const name of typeParameterNames(fn)) names.add(name);
    for (let current = owner; current; current = types.enclosing(current)) for (const name of typeParameterNames(current.node)) names.add(name);
    return names;
  };

  // ---- Types as values ----
  const typeValue = (written: string | null | undefined, context: Context, depth = 0): Value | null => {
    const name = normalizeCSharpType(written);
    if (!name) return null;
    if (!name.includes(".") && typeVariables(context.type, context.fn).has(name)) return null;
    const scope = scopeOfContext(context);
    const text = written ?? "";
    const written_ = trailingGenericArguments(text);
    const args = depth < 3 && written_ ? written_.map((argument) => typeValue(argument, context, depth + 1)) : undefined;
    if (name.endsWith("[]")) return { type: null, ext: name, isType: false };
    // `Box<int>` is a type of one generic parameter: a non-generic `Box` is not it (no arity-less fallback).
    const type = types.resolve(name, scope, trailingArity(text));
    const value: Value = type ? { type, ext: null, isType: false } : { type: null, ext: canonicalExternalType(name), isType: false };
    if (args && args.length > 0) value.args = args;
    return value;
  };

  // The type a member's declared type means, with the owner's type parameters replaced by the receiver's arguments.
  const memberValue = (written: string | null | undefined, owner: CSharpType, member: GraphNode, receiver: Value | null): Value | null => {
    const name = normalizeCSharpType(written);
    if (!name) return null;
    const ownerParameters = typeParameterNames(owner.node);
    const bound = (argument: string): Value | null => {
      const position = ownerParameters.indexOf(argument);
      return position >= 0 && receiver?.type?.id === owner.id ? receiver.args?.[position] ?? null : null;
    };
    if (!name.includes(".")) {
      if (typeParameterNames(member).includes(name)) return null;
      if (ownerParameters.includes(name)) return bound(name);
    }
    const value = typeValue(written, contextOf(owner, member));
    // `Box<T> Self()` on a `Box<Item>`: the arguments that are type parameters of the owner take the receiver's.
    if (value?.args && ownerParameters.length > 0 && receiver?.type?.id === owner.id) {
      const writtenArguments = trailingGenericArguments(written ?? "") ?? [];
      value.args = value.args.map((argument, position) => argument ?? bound(normalizeCSharpType(writtenArguments[position]) ?? ""));
    }
    return value;
  };

  const sameValue = (left: Value | null, right: Value | null): boolean =>
    left !== null && right !== null && (left.type ? left.type.id === right.type?.id : left.ext !== null && left.ext === right.ext);

  // ---- Method lookup ----
  const bounds = (fn: GraphNode, offset: number): { min: number; max: number } => {
    const total = typeof fn.properties.parameterCount === "number" ? fn.properties.parameterCount : paramsOf(fn).length;
    const required = typeof fn.properties.requiredParameterCount === "number" ? fn.properties.requiredParameterCount : total;
    return { min: Math.max(0, required - offset), max: fn.properties.hasParams === true ? Number.POSITIVE_INFINITY : Math.max(0, total - offset) };
  };
  const accepts = (fn: GraphNode, arity: number | undefined, offset = 0): boolean => {
    if (arity === undefined) return true;
    const { min, max } = bounds(fn, offset);
    return arity >= min && arity <= max;
  };

  const normOf = (text: string): string => normalizeCSharpType(text) ?? "\0";

  // `sub` replaces `sup` when a subtype redeclares it (override, `new`, or an implementation of an interface member): same
  // name and parameter count, and each parameter type equal or (where the supertype wrote a type variable) anything.
  const overrides = (sub: GraphNode, subOwner: CSharpType, sup: GraphNode, supOwner: CSharpType): boolean => {
    if (sub.properties.name !== sup.properties.name || sub.properties.isStatic === true || sup.properties.isStatic === true) return false;
    const subParams = paramsOf(sub);
    const supParams = paramsOf(sup);
    if (subParams.length !== supParams.length) return false;
    const supVariables = typeVariables(supOwner, sup);
    const subVariables = typeVariables(subOwner, sub);
    return supParams.every((param, position) => {
      const left = normOf(subParams[position]!.type);
      const right = normOf(param.type);
      return left === right || supVariables.has(right) || subVariables.has(left);
    });
  };

  const sameParameters = (left: GraphNode, right: GraphNode): boolean => {
    const leftParams = paramsOf(left);
    const rightParams = paramsOf(right);
    return leftParams.length === rightParams.length && leftParams.every((param, position) => normOf(param.type) === normOf(rightParams[position]!.type));
  };

  // The methods called `name` that fit `arity` on a type and its supertypes, nearest first, without the ones a nearer declaration replaces.
  const findMethods = (start: CSharpType, name: string, arity: number | undefined): Candidate[] => {
    const found: Candidate[] = [];
    const seen = new Set<string>();
    const queue: CSharpType[] = [start];
    while (queue.length > 0) {
      const type = queue.shift()!;
      if (seen.has(type.id)) continue;
      seen.add(type.id);
      const own = methodsByOwner.get(type.id) ?? [];
      for (const fn of own) {
        // An explicit interface implementation (`void IFoo.M()`) cannot be called through the class.
        if (fn.properties.kind !== "method" || fn.properties.name !== name || typeof fn.properties.explicitInterface === "string" || !accepts(fn, arity)) continue;
        // A `partial` method declaration without a body is the implementing part's: one target, the part with the body.
        if (fn.properties.isPartial === true && fn.properties.hasBody === false && own.some((other) => other !== fn && other.properties.isPartial === true && other.properties.hasBody === true && other.properties.name === name && sameParameters(other, fn))) continue;
        if (found.some((other) => other.owner.id !== type.id && overrides(other.fn, other.owner, fn, type))) continue;
        found.push({ fn, owner: type });
      }
      queue.push(...types.supertypes(type));
    }
    return found;
  };

  const findField = (start: CSharpType, name: string): { field: GraphNode; owner: CSharpType } | null => {
    const seen = new Set<string>();
    const queue: CSharpType[] = [start];
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

  const valueOfField = (found: { field: GraphNode; owner: CSharpType }, receiver: Value | null): Value | null =>
    memberValue(String(found.field.properties.declaredType ?? found.field.properties.typeName ?? ""), found.owner, found.field, receiver);

  // The value a call yields, when every candidate agrees on its return type.
  // `self`: the receiver of an extension call, which a generic extension (`T Pick<T>(this T t)`) returns as it is.
  const resultOf = (candidates: Candidate[], receiver: Value | null, self: Value | null = null): Value | null => {
    let result: Value | null = null;
    for (const { fn, owner } of candidates) {
      const returned = typeof fn.properties.returnType === "string" ? fn.properties.returnType : null;
      const returnsSelf = self !== null && fn.properties.isExtension === true && normalizeCSharpType(returned) === fn.properties.extensionReceiver && typeParameterNames(fn).includes(String(fn.properties.extensionReceiver));
      const value = returnsSelf ? { ...self!, exact: false, superRef: false } : memberValue(returned, owner, fn, receiver);
      if (!value || (result && !sameValue(result, value))) return null;
      result = value;
    }
    return result;
  };

  const superclassOf = (type: CSharpType): CSharpType | null => types.supertypes(type).find((candidate) => !candidate.isInterface) ?? null;

  // `using static` types in scope that bring `name` into scope as a method, as (type, candidates).
  const staticImported = (scope: Scope, name: string, arity: number | undefined): { type: CSharpType; candidates: Candidate[] } | null => {
    for (const level of types.usingScope(scope.fileId, scope.namespace, scope.line)) {
      for (const source of level.statics) {
        const type = types.byQualifiedName(source);
        if (!type) continue;
        const candidates = findMethods(type, name, arity).filter((candidate) => candidate.fn.properties.isStatic === true);
        if (candidates.length > 0) return { type, candidates };
      }
    }
    return null;
  };

  // A method named without a receiver: of the enclosing types (innermost first), then imported with `using static`.
  const bareMethods = (scope: Scope, name: string, arity: number | undefined): { value: Value; candidates: Candidate[] } | null => {
    for (let current = scope.type; current; current = types.enclosing(current)) {
      const candidates = findMethods(current, name, arity);
      if (candidates.length > 0) return { value: { type: current, ext: null, isType: false }, candidates };
    }
    const imported = staticImported(scope, name, arity);
    return imported ? { value: { type: imported.type, ext: null, isType: true }, candidates: imported.candidates } : null;
  };

  // ---- Extension methods ----
  const extensionVisible = (owner: CSharpType, scope: Scope): boolean => {
    // An alias (`using E = Acme.Ext;`) brings no extension methods into scope, but it does not hide the ones another level does.
    for (const level of types.usingScope(scope.fileId, scope.namespace, scope.line)) {
      if (level.namespace === owner.namespace || level.usings.includes(owner.namespace) || level.statics.includes(owner.qualifiedName)) return true;
    }
    return false;
  };
  const closureOf = (type: CSharpType): CSharpType[] => {
    const all = [type];
    for (let position = 0; position < all.length; position += 1) for (const parent of types.supertypes(all[position]!)) if (!all.includes(parent)) all.push(parent);
    return all;
  };
  const receiverMatches = (candidate: Candidate, receiver: Value): boolean => {
    const { fn, owner } = candidate;
    const written = typeof fn.properties.extensionReceiver === "string" ? fn.properties.extensionReceiver : normalizeCSharpType(paramsOf(fn)[0]?.type);
    const name = normalizeCSharpType(written);
    if (!name) return false;
    const context = contextOf(owner, fn);
    if (isTypeVariableName(name, typeParameterNames(fn))) {
      // `this T x where T : Shape`: a constraint the scan resolves must hold; the others (`class`, `new()`, System types) are not checked.
      const constraints = parseJsonList<{ param: string; constraints: string[] }>(fn.properties.constraints).filter((entry) => entry.param === name).flatMap((entry) => entry.constraints);
      for (const constraint of constraints) {
        const target = types.resolve(normalizeCSharpType(constraint) ?? "", { ...scopeOfContext(context), typeId: owner.id });
        if (target && !(receiver.type && closureOf(receiver.type).some((type) => type.id === target.id))) return false;
      }
      return true;
    }
    const target = types.resolve(name, { ...scopeOfContext(context), typeId: owner.id });
    if (target) return receiver.type !== null && closureOf(receiver.type).some((type) => type.id === target.id);
    const wanted = canonicalExternalType(name);
    if (wanted === "object") return true;
    if (receiver.ext !== null) return receiver.ext === wanted || externalSupertypes(receiver.ext).includes(wanted);
    if (receiver.type) {
      // A scan type reaches System types through the bases the scan does not hold (`class Bag : IEnumerable<int>`).
      return closureOf(receiver.type).some((type) => parseJsonList<{ name: string; relation: string }>(type.node.properties.bases).some((base) => {
        if (base.relation === "underlying") return false;
        const scope = { fileId: type.fileIds[0]!, typeId: types.enclosing(type)?.id ?? null, namespace: type.namespace };
        if (types.resolve(base.name, scope)) return false;
        const baseName = canonicalExternalType(base.name);
        return baseName === wanted || externalSupertypes(baseName).includes(wanted);
      }));
    }
    return false;
  };
  const extensionCandidates = (receiver: Value, name: string, arity: number | undefined, scope: Scope): Candidate[] =>
    (extensionsByName.get(name) ?? []).filter((candidate) => accepts(candidate.fn, arity, 1) && extensionVisible(candidate.owner, scope) && receiverMatches(candidate, receiver));

  // ---- Walking receivers ----
  const contextOfScope = (scope: Scope): Context => ({ fileId: scope.fileId, type: scope.type, namespace: scope.namespace, fn: scope.fn, line: scope.line });

  // A field or property called `name` of the owner (enclosing types and their supertypes).
  const fieldNamed = (scope: Scope, name: string): ReturnType<typeof findField> => {
    let field: ReturnType<typeof findField> = null;
    for (let owner = scope.type; owner && !field; owner = types.enclosing(owner)) field = findField(owner, name);
    return field;
  };

  const lookupLocal = (scope: Scope, name: string): Value | null => {
    const local = scope.locals.get(name);
    if (!local) return null;
    // A local declared in a sibling block can share its name with a field: which one the use site means is not known.
    if (!(scope.fn && paramsOf(scope.fn).some((param) => param.name === name)) && fieldNamed(scope, name)) return null;
    if (local.type) return typeValue(local.fullType ?? local.type, contextOfScope(scope));
    if (!local.initializer || scope.resolving.has(name)) return null;
    // `var x = Make();`, `var x = obj.Prop;`, `var x = await M();`: the type of the initializer.
    scope.resolving.add(name);
    try {
      let text = local.initializer;
      const awaited = /^await\s+/u.test(text);
      if (awaited) text = text.replace(/^await\s+/u, "");
      const value = evaluate(text, scope);
      if (!value || value.isType) return null;
      if (!awaited) return value;
      // `Task<T>` / `ValueTask<T>` awaits to `T`; anything else (a plain `Task`, an unknown awaitable) is not typed.
      return value.ext !== null && (value.ext === "Task" || value.ext === "ValueTask") ? value.args?.[0] ?? null : null;
    } finally {
      scope.resolving.delete(name);
    }
  };

  // The methods `name` reaches on a value: the type's own, then (for an instance) extension methods in scope.
  const methodsOnValue = (value: Value, name: string, arity: number | undefined, scope: Scope): { candidates: Candidate[]; extension: boolean } => {
    if (value.type) {
      let candidates = findMethods(value.type, name, arity);
      if (value.isType) {
        if (candidates.some((candidate) => candidate.fn.properties.isStatic === true)) candidates = candidates.filter((candidate) => candidate.fn.properties.isStatic === true);
      } else {
        candidates = candidates.filter((candidate) => candidate.fn.properties.isStatic !== true);
      }
      if (candidates.length > 0 || value.isType) return { candidates, extension: false };
    }
    return value.isType ? { candidates: [], extension: false } : { candidates: extensionCandidates(value, name, arity, scope), extension: true };
  };

  const literalValue = (segment: Extract<Segment, { kind: "literal" }>): Value => ({ type: null, ext: segment.type, isType: false });

  const evaluate = (text: string, scope: Scope): Value | null => {
    const segments = splitChain(text);
    if (!segments || segments.length === 0) return null;
    const first = segments[0]!;
    let current: Value | null = null;
    let position = 1;
    const context = contextOfScope(scope);
    switch (first.kind) {
      case "literal":
        current = literalValue(first);
        break;
      case "new": {
        // `new Box<Foo>()`: the arguments it is written with go into the chain (`.Get()` is a `Foo`).
        const value = typeValue(first.written, context);
        current = value ? { ...value, exact: true } : null;
        break;
      }
      case "paren": {
        current = first.cast !== null ? typeValue(first.cast, context) : evaluate(first.inner, scope);
        break;
      }
      case "call": {
        const found = bareMethods(scope, first.name, first.argCount);
        current = found ? resultOf(found.candidates, found.value) : null;
        break;
      }
      case "name": {
        if (first.name === "this") {
          current = scope.type ? { type: scope.type, ext: null, isType: false } : null;
        } else if (first.name === "base") {
          const parent = scope.type ? superclassOf(scope.type) : null;
          current = parent ? { type: parent, ext: null, isType: false, superRef: true } : null;
        } else if (scope.locals.has(first.name)) {
          current = lookupLocal(scope, first.name);
        } else {
          const field = fieldNamed(scope, first.name);
          if (field) {
            current = valueOfField(field, null);
          } else {
            const typeScope = scopeOfContext(context);
            let written = first.name;
            let type = types.resolve(written, typeScope);
            // `Ns.Type`, `Alias.Type`, `Outer.Inner`: the leading names are a namespace or an outer type.
            for (let next = 1; !type && next < segments.length && segments[next]!.kind === "name"; next += 1) {
              written += `.${(segments[next] as { name: string }).name}`;
              type = types.resolve(written, typeScope);
              position = next + 1;
            }
            if (type) current = { type, ext: null, isType: true };
            else position = 1;
          }
        }
        break;
      }
    }
    for (; position < segments.length; position += 1) {
      if (!current) return null;
      const segment = segments[position]!;
      if (segment.kind === "call") {
        const reached = methodsOnValue(current, segment.name, segment.argCount, scope);
        current = resultOf(reached.candidates, reached.extension ? null : current, reached.extension ? current : null);
      } else if (segment.kind === "name") {
        if (!current.type) return null;
        const nested = current.isType ? types.byQualifiedName(`${current.type.qualifiedName}.${segment.name}`) : null;
        if (nested) {
          current = { type: nested, ext: null, isType: true };
        } else {
          const field = findField(current.type, segment.name);
          current = field ? valueOfField(field, current) : null;
        }
      } else {
        return null;
      }
    }
    return current;
  };

  // ---- Overloads ----
  // Overloads of one arity told apart by the arguments whose type is certain (a type of the scan, a string or primitive
  // literal) against parameters whose type is certain too. Keeps every candidate when none would be left.
  type Kind = { kind: "scan"; type: CSharpType } | { kind: "string" } | { kind: "primitive" };
  const argumentKind = (token: string | null, scope: Scope): Kind | null => {
    if (token === null || token === "null") return null;
    if (primitiveTypes.has(token)) return { kind: "primitive" };
    if (token === "string") return { kind: "string" };
    if (token === "this" || token.startsWith("@")) {
      const value = evaluate(token === "this" ? token : token.slice(1), scope);
      if (!value || value.isType) return null;
      if (value.type) return { kind: "scan", type: value.type };
      return value.ext === "string" ? { kind: "string" } : value.ext !== null && primitiveTypes.has(value.ext) ? { kind: "primitive" } : null;
    }
    const type = types.resolve(token, scopeOfContext(contextOfScope(scope)));
    return type ? { kind: "scan", type } : null;
  };
  const parameterKind = (param: Param, owner: CSharpType, fn: GraphNode): Kind | null => {
    if (param.params === true) return null;
    const name = normalizeCSharpType(param.type);
    if (!name) return null;
    if (primitiveTypes.has(name)) return { kind: "primitive" };
    if (name === "string") return { kind: "string" };
    if (!name.includes(".") && typeVariables(owner, fn).has(name)) return null;
    const type = types.resolve(name, scopeOfContext(contextOf(owner, fn)));
    return type ? { kind: "scan", type } : null;
  };
  const incompatible = (argument: Kind, parameter: Kind): boolean => {
    if (argument.kind === "scan" && parameter.kind === "scan") return argument.type.id !== parameter.type.id && !types.subtypes(parameter.type).some((sub) => sub.id === argument.type.id);
    if (argument.kind === "primitive" && parameter.kind === "primitive") return false;
    return argument.kind !== parameter.kind;
  };
  const narrow = (candidates: Candidate[], scope: Scope, offset = 0): Candidate[] => {
    const tokens = parseJsonList<unknown>(scope.call.properties.argumentTypes).map((item) => (typeof item === "string" ? item : null));
    if (candidates.length < 2 || tokens.length === 0) return candidates;
    const kinds = tokens.map((token) => argumentKind(token, scope));
    if (kinds.every((kind) => kind === null)) return candidates;
    const kept = candidates.filter(({ fn, owner }) => {
      const params = paramsOf(fn);
      return !kinds.some((argument, position) => {
        const param = params[position + offset];
        if (!argument || !param) return false;
        const parameter = parameterKind(param, owner, fn);
        return parameter !== null && incompatible(argument, parameter);
      });
    });
    return kept.length > 0 ? kept : candidates;
  };

  // ---- Targets ----
  const dispatchTargets = (candidate: Candidate, receiver: Value, add: (fn: GraphNode, via?: string) => void): void => {
    const { fn, owner } = candidate;
    if (receiver.exact || receiver.superRef || receiver.isType || !receiver.type || fn.properties.isStatic === true || fn.properties.visibility === "private") return;
    const overridable = owner.isInterface || fn.properties.isVirtual === true || fn.properties.isAbstract === true || fn.properties.isOverride === true;
    if (!overridable) return;
    const arity = paramsOf(fn).length;
    for (const subtype of types.subtypes(receiver.type)) {
      for (const other of findMethods(subtype, String(fn.properties.name), undefined)) {
        if (other.owner.id === owner.id || other.fn.id === fn.id || paramsOf(other.fn).length !== arity) continue;
        if (!overrides(other.fn, other.owner, fn, owner)) continue;
        // An interface member is implemented by the method the implementing type sees: a derived class's `new` method that
        // does not re-implement the interface is not it.
        if (other.fn.properties.isOverride === true || (owner.isInterface && implementsDirectly(subtype, owner))) add(other.fn, "override");
      }
      if (owner.isInterface) {
        // `void IFoo.M()` in an implementing type runs when the interface method is called.
        for (const other of methodsByOwner.get(subtype.id) ?? []) {
          if (other.properties.kind !== "method" || typeof other.properties.explicitInterface !== "string" || other.properties.name !== fn.properties.name) continue;
          if (normOf(String(other.properties.explicitInterface)).split(".").at(-1) === owner.name && paramsOf(other).length === arity) add(other, "override");
        }
      }
    }
  };

  // True when `type` lists `iface` (or an interface that extends it) in its own base list.
  const implementsDirectly = (type: CSharpType, iface: CSharpType): boolean =>
    types.supertypes(type).some((parent) => parent.isInterface && (parent.id === iface.id || types.subtypes(iface).some((sub) => sub.id === parent.id)));

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

  const constructorsOf = (type: CSharpType | null, arity: number | undefined, scope: Scope): ResolvedCallTarget[] => {
    if (!type || type.isInterface) return [];
    const all = (methodsByOwner.get(type.id) ?? []).filter((fn) => fn.properties.kind === "constructor" && fn.properties.isStatic !== true && accepts(fn, arity)).map((fn) => ({ fn, owner: type }));
    const candidates = narrow(all, scope);
    return candidates.map(({ fn }) => (candidates.length > 1 ? { functionId: fn.id, via: "overload" } : { functionId: fn.id }));
  };

  const methodTargets = (value: Value | null, name: string, arity: number | undefined, scope: Scope): ResolvedCallTarget[] => {
    if (!value) return [];
    const { candidates, extension } = methodsOnValue(value, name, arity, scope);
    // An extension call `x.Ext(a)` has one argument fewer than the method's parameters (`this` is the receiver).
    return toTargets(narrow(candidates, scope, extension ? 1 : 0), extension ? null : value);
  };

  return (call, callerFileId, callerFunctionId) => {
    const fn = callerFunctionId ? graph.node(callerFunctionId) : undefined;
    const ownerId = callerFunctionId ? ownerByFunction.get(callerFunctionId) : undefined;
    const owner = ownerId ? types.byId.get(ownerId) ?? null : null;
    // A `partial` type spans files: the method's own file decides what is in scope, not the type's last file.
    const fileId = fileOfMember(fn, owner) ?? callerFileId;
    if (!owner && !(fn && isCSharpFile(fileId))) return [];
    const scope: Scope = {
      call,
      fileId: isCSharpFile(fileId) ? fileId : callerFileId,
      type: owner,
      namespace: owner?.namespace ?? (typeof fn?.properties.namespace === "string" ? fn.properties.namespace : ""),
      fn,
      locals: localsOf(fn),
      line: typeof fn?.properties.line === "number" ? fn.properties.line : undefined,
      resolving: new Set(),
    };
    const callee = typeof call.properties.callee === "string" ? call.properties.callee : "";
    const receiver = typeof call.properties.receiver === "string" ? call.properties.receiver : null;
    const arity = typeof call.properties.argumentCount === "number" ? call.properties.argumentCount : undefined;
    switch (call.properties.callKind) {
      case "method": {
        if (receiver === null) {
          // `Helper()` where `Helper` is a local function, a delegate local or a delegate parameter is not a method of the class.
          if (scope.locals.has(callee)) {
            const local = scope.locals.get(callee);
            if (!local || !local.type || !(primitiveTypes.has(local.type) || local.type === "string")) return [];
          }
          const found = bareMethods(scope, callee, arity);
          return found ? toTargets(narrow(found.candidates, scope), found.value) : [];
        }
        // A receiver too long to be stored whole is not evaluated.
        if (call.properties.receiverTruncated === true) return [];
        return methodTargets(evaluate(receiver, scope), callee, arity, scope);
      }
      case "explicitConstructor":
        if (!owner) return [];
        return constructorsOf(callee === "base" ? superclassOf(owner) : owner, arity, scope);
      case "constructor": {
        const qualifier = typeof call.properties.qualifier === "string" ? call.properties.qualifier : null;
        // `new T()` where `T` is a type parameter constructs nothing of the scan.
        if (qualifier === null && typeVariables(owner, fn).has(callee)) return [];
        const typeArity = typeof call.properties.typeArity === "number" ? call.properties.typeArity : undefined;
        const written = qualifier ? `${qualifier}.${callee}` : callee;
        // `new Box<string>()` is the `Box<T>`: with the arity written there is no arity-less fallback.
        const type = types.resolve(written, scopeOfContext(contextOfScope(scope)), typeArity);
        return constructorsOf(type, arity, scope);
      }
      default:
        return [];
    }
  };
}

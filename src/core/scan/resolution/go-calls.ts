import path from "node:path";
import type { IGraphContributor } from "../../contracts/graph-contributor.js";
import type { GraphNode } from "../../graph/model.js";
import type { ResolutionRelationshipIndex } from "./indexes.js";
import { isGoFile } from "./file-kind.js";

// Go calls resolve by package, not by file: a package is the files of one
// directory with the same package clause, and an import names a package.
export type GoCallIndex = {
  packageByFile: Map<string, string>;
  functionsByPackage: Map<string, Map<string, GraphNode>>;
  // `Type.method` per package.
  methodsByPackage: Map<string, Map<string, string>>;
  typesByPackage: Map<string, Map<string, { node: GraphNode; fileId: string }>>;
  interfacesByPackage: Map<string, Map<string, { node: GraphNode; fileId: string }>>;
  // Structs per interface (IMPLEMENTS), as type references.
  implementersByInterface: Map<string, TypeRef[]>;
  fileByFunctionId: Map<string, string>;
  // Imported packages per file by local name; `.` imports under ".".
  importsByFile: Map<string, Map<string, string[]>>;
  functionsById: Map<string, GraphNode>;
};

// A named type, or an anonymous struct (a field's `struct { … }`) with its
// fields and the file their types are written in.
export type TypeRef = { pkg: string; name: string; anonymous?: { fields: Field[]; fileId: string } };

type Field = { name: string; type: string; embedded?: true; fields?: Field[] };

export function createGoCallIndex(graph: IGraphContributor, relationshipIndex: ResolutionRelationshipIndex): GoCallIndex {
  const files = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (node.label === "File" && isGoFile(node.id)) files.set(node.id, node);
  }
  const packageByFile = new Map<string, string>();
  for (const [fileId, node] of files) {
    const relativePath = String(node.properties.relativePath ?? fileId.slice("file:".length)).replaceAll("\\", "/");
    packageByFile.set(fileId, `${path.posix.dirname(relativePath)}\0${String(node.properties.packageName ?? "")}`);
  }

  const index: GoCallIndex = {
    packageByFile,
    functionsByPackage: new Map(),
    methodsByPackage: new Map(),
    typesByPackage: new Map(),
    interfacesByPackage: new Map(),
    implementersByInterface: new Map(),
    fileByFunctionId: relationshipIndex.fileByFunctionId,
    importsByFile: new Map(),
    functionsById: new Map(),
  };

  const targetsByImport = new Map<string, string[]>();
  for (const relationship of graph.relationships) {
    if (relationship.type !== "RESOLVES_TO" || !isGoFile(relationship.from.split(":import:")[0]!)) continue;
    targetsByImport.set(relationship.from, [...targetsByImport.get(relationship.from) ?? [], relationship.to]);
  }

  for (const node of graph.nodes) {
    if (node.label === "Function") {
      index.functionsById.set(node.id, node);
      const pkg = packageByFile.get(relationshipIndex.fileByFunctionId.get(node.id) ?? "");
      if (pkg === undefined) continue;
      const name = String(node.properties.name);
      const className = node.properties.className;
      if (typeof className === "string") {
        nested(index.methodsByPackage, pkg).set(`${className}.${name}`, node.id);
      } else if (!nested(index.functionsByPackage, pkg).has(name)) {
        nested(index.functionsByPackage, pkg).set(name, node);
      }
    } else if (node.label === "Class") {
      const fileId = relationshipIndex.fileByClassId.get(node.id);
      const pkg = packageByFile.get(fileId ?? "");
      if (pkg !== undefined) nested(index.typesByPackage, pkg).set(String(node.properties.name), { node, fileId: fileId! });
    } else if (node.label === "Interface") {
      const fileId = relationshipIndex.fileByInterfaceId.get(node.id);
      const pkg = packageByFile.get(fileId ?? "");
      if (pkg !== undefined) nested(index.interfacesByPackage, pkg).set(String(node.properties.name), { node, fileId: fileId! });
    } else if (node.label === "Import") {
      const fileId = relationshipIndex.fileByImportId.get(node.id);
      const targets = targetsByImport.get(node.id);
      if (!fileId || !targets || !packageByFile.has(fileId)) continue;
      const pkg = packageByFile.get(targets[0]!);
      if (pkg === undefined) continue;
      const alias = typeof node.properties.alias === "string" ? node.properties.alias : null;
      if (alias === "_") continue;
      const local = alias ?? packageName(pkg) ?? defaultPackageName(String(node.properties.source));
      const imports = nested(index.importsByFile, fileId);
      imports.set(local, [...imports.get(local) ?? [], pkg]);
    }
  }

  const typeRefByClassId = new Map<string, TypeRef>();
  for (const [pkg, types] of index.typesByPackage) {
    for (const [name, { node }] of types) typeRefByClassId.set(node.id, { pkg, name });
  }
  for (const relationship of graph.relationships) {
    if (relationship.type !== "IMPLEMENTS") continue;
    const implementer = typeRefByClassId.get(relationship.from);
    if (implementer) index.implementersByInterface.set(relationship.to, [...index.implementersByInterface.get(relationship.to) ?? [], implementer]);
  }

  return index;
}

// Go has no `implements`: a struct implements every interface whose methods
// are all in its method set (its own methods, value or pointer receivers,
// and the ones promoted from embedded structs), matched by name. Interfaces
// without methods (`any`, constraints) are left out.
export function addGoImplementsRelationships(graph: IGraphContributor, relationshipIndex: ResolutionRelationshipIndex): void {
  if (![...relationshipIndex.fileByInterfaceId.values()].some(isGoFile)) return;
  const index = createGoCallIndex(graph, relationshipIndex);
  const interfaces = [...index.interfacesByPackage].flatMap(([pkg, byName]) => [...byName.keys()].map((name) => ({ pkg, name })));
  const required = interfaces
    .map((ref) => ({ ref, id: index.interfacesByPackage.get(ref.pkg)!.get(ref.name)!.node.id, methods: interfaceMethods(ref, index, 0) }))
    .filter((entry) => entry.methods !== null && entry.methods.size > 0);
  if (required.length === 0) return;
  for (const [pkg, types] of index.typesByPackage) {
    for (const [name, { node }] of types) {
      const type = { pkg, name };
      for (const entry of required) {
        if ([...entry.methods!].every((method) => methodOf(type, method, index, 0).length > 0)) {
          graph.addRelationship({ from: node.id, to: entry.id, type: "IMPLEMENTS", properties: {} });
        }
      }
    }
  }
}

// An interface's methods with those of the interfaces it embeds; null when
// an embedded interface is not one of the scan's (its methods are unknown).
function interfaceMethods(ref: TypeRef, index: GoCallIndex, depth: number): Set<string> | null {
  const entry = index.interfacesByPackage.get(ref.pkg)?.get(ref.name);
  if (!entry || depth > 4) return null;
  const methods = new Set(parseList(entry.node.properties.methods));
  for (const embedded of parseList(entry.node.properties.embeds)) {
    const embeddedRef = resolveType(embedded, entry.fileId, index);
    const inherited = embeddedRef ? interfaceMethods(embeddedRef, index, depth + 1) : null;
    if (!inherited) return null;
    for (const method of inherited) methods.add(method);
  }
  return methods;
}

export type GoCallTarget = { functionId: string; via?: "interface" };

// The functions a call made in `callerFileId` reaches: one, every
// implementation of an interface method (marked), or none when the callee is
// not one of the scan's (the standard library, a dependency) or the
// receiver's type is unknown.
export function resolveGoCall(call: GraphNode, callerFileId: string, index: GoCallIndex): GoCallTarget[] {
  const found = resolveGoCallTarget(call, callerFileId, index);
  if (found === null) return [];
  return typeof found === "string" ? [{ functionId: found }] : found.map((functionId) => ({ functionId, via: "interface" as const }));
}

function resolveGoCallTarget(call: GraphNode, callerFileId: string, index: GoCallIndex): string | string[] | null {
  const callee = call.properties.callee;
  const receiver = call.properties.receiver;
  const pkg = index.packageByFile.get(callerFileId);
  if (typeof callee !== "string" || pkg === undefined) return null;

  if (typeof receiver !== "string") {
    const own = index.functionsByPackage.get(pkg)?.get(callee)?.id;
    if (own) return own;
    for (const dotPackage of index.importsByFile.get(callerFileId)?.get(".") ?? []) {
      const found = index.functionsByPackage.get(dotPackage)?.get(callee)?.id;
      if (found) return found;
    }
    return null;
  }

  // `NewX().Run()` and `a[i].Run()`: the receiver is an expression's result.
  const expression = String(call.properties.expression ?? "");
  if (/[()[\]]/u.test(expression.slice(0, expression.lastIndexOf(".")))) return null;

  const [root, ...fields] = receiver.split(".");
  let type: TypeRef | null = null;
  if (typeof call.properties.receiverType === "string") {
    type = resolveType(call.properties.receiverType, callerFileId, index);
  } else if (typeof call.properties.receiverConstructor === "string") {
    type = constructedType(call.properties.receiverConstructor, callerFileId, index);
  } else if (call.properties.receiverIsLocal === true) {
    return null;
  } else if (fields.length === 0) {
    // `pkg.Func()`.
    for (const target of index.importsByFile.get(callerFileId)?.get(root!) ?? []) {
      const found = index.functionsByPackage.get(target)?.get(callee)?.id;
      if (found) return found;
    }
    return null;
  }

  for (const field of fields) {
    if (!type) return null;
    type = fieldType(type, field, index);
  }
  if (!type) return null;
  const iface = index.interfacesByPackage.get(type.pkg)?.get(type.name);
  if (iface) {
    const implementations = (index.implementersByInterface.get(iface.node.id) ?? []).flatMap((implementer) => methodOf(implementer, callee, index, 0).slice(0, 1));
    return implementations.length > 0 ? [...new Set(implementations)].sort() : null;
  }
  return methodOf(type, callee, index, 0)[0] ?? null;
}

// `*db.Store`, `Store[T]` → the package and name of the type.
export function resolveType(text: string, fileId: string, index: GoCallIndex): TypeRef | null {
  const base = text.replace(/^\*/u, "").replace(/\[.*$/u, "");
  if (!/^[\w.]+$/u.test(base)) return null;
  const [qualifier, name] = base.includes(".") ? base.split(".") : [null, base];
  if (!name) return null;
  if (qualifier === null) {
    const pkg = index.packageByFile.get(fileId);
    if (pkg !== undefined && hasType(pkg, name, index)) return { pkg, name };
    for (const dotPackage of index.importsByFile.get(fileId)?.get(".") ?? []) {
      if (hasType(dotPackage, name, index)) return { pkg: dotPackage, name };
    }
    return pkg === undefined ? null : { pkg, name };
  }
  const targets = index.importsByFile.get(fileId)?.get(qualifier) ?? [];
  const pkg = targets.find((target) => hasType(target, name, index)) ?? targets[0];
  return pkg === undefined ? null : { pkg, name };
}

function hasType(pkg: string, name: string, index: GoCallIndex): boolean {
  return index.typesByPackage.get(pkg)?.has(name) === true || index.interfacesByPackage.get(pkg)?.has(name) === true;
}

// `x := NewStore()` / `store.New()`: the type the constructor returns first.
function constructedType(constructor: string, fileId: string, index: GoCallIndex): TypeRef | null {
  // `(*Handler).store.Get`: the result of a method reached through fields.
  const onType = /^\((.+)\)\.(.+)$/u.exec(constructor);
  if (onType) return methodResultType(onType[1]!, onType[2]!.split("."), fileId, index);
  const [qualifier, name] = constructor.includes(".") ? constructor.split(".") : [null, constructor];
  const pkgs = qualifier === null
    ? [index.packageByFile.get(fileId)!, ...index.importsByFile.get(fileId)?.get(".") ?? []]
    : index.importsByFile.get(fileId)?.get(qualifier) ?? [];
  for (const pkg of pkgs) {
    const fn = index.functionsByPackage.get(pkg)?.get(name!);
    if (!fn) continue;
    const result = firstResultType(fn.properties.returnType);
    const fnFile = index.fileByFunctionId.get(fn.id);
    return result && fnFile ? resolveType(result, fnFile, index) : null;
  }
  // A conversion or a type's literal name used like a call: `Store(x)`.
  return qualifier === null && index.typesByPackage.get(pkgs[0]!)?.has(name!) ? { pkg: pkgs[0]!, name: name! } : null;
}

// The type a method returns first, on a value of `typeText` through
// `fields`; for an interface, the result its implementations agree on.
function methodResultType(typeText: string, path: string[], fileId: string, index: GoCallIndex): TypeRef | null {
  let type = resolveType(typeText, fileId, index);
  const method = path.pop();
  for (const field of path) {
    if (!type) return null;
    type = fieldType(type, field, index);
  }
  if (!type || !method) return null;
  const iface = index.interfacesByPackage.get(type.pkg)?.get(type.name);
  const owners = iface ? index.implementersByInterface.get(iface.node.id) ?? [] : [type];
  const results = new Map<string, TypeRef>();
  for (const owner of owners) {
    const functionId = methodOf(owner, method, index, 0)[0];
    const fn = functionId ? index.functionsById.get(functionId) : undefined;
    const fnFile = fn ? index.fileByFunctionId.get(fn.id) : undefined;
    const result = fn ? firstResultType(fn.properties.returnType) : null;
    const resolved = result && fnFile ? resolveType(result, fnFile, index) : null;
    if (resolved) results.set(`${resolved.pkg}\0${resolved.name}`, resolved);
  }
  return results.size === 1 ? [...results.values()][0]! : null;
}

// `(*Store, error)` → `*Store`; `(s *Store, err error)` → `*Store`.
export function firstResultType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.replace(/^\(\s*/u, "").replace(/\s*\)$/u, "").split(",")[0]!.trim();
  const parts = first.split(/\s+/u);
  return parts[parts.length - 1] || null;
}

function fieldType(type: TypeRef, field: string, index: GoCallIndex): TypeRef | null {
  const owner = type.anonymous ?? (() => {
    const named = index.typesByPackage.get(type.pkg)?.get(type.name);
    return named ? { fields: parseFields(named.node), fileId: named.fileId } : null;
  })();
  if (!owner) return null;
  const found = owner.fields.find((candidate) => candidate.name === field);
  if (!found) return null;
  if (found.fields) return { pkg: type.pkg, name: "", anonymous: { fields: found.fields, fileId: owner.fileId } };
  return resolveType(found.type, owner.fileId, index);
}

// A method of the type itself or promoted from a field it embeds (empty
// when there is none).
function methodOf(type: TypeRef, method: string, index: GoCallIndex, depth: number): string[] {
  const own = index.methodsByPackage.get(type.pkg)?.get(`${type.name}.${method}`);
  if (own) return [own];
  const owner = index.typesByPackage.get(type.pkg)?.get(type.name);
  if (!owner || depth > 3) return [];
  for (const field of parseFields(owner.node)) {
    if (!field.embedded) continue;
    const embedded = resolveType(field.type, owner.fileId, index);
    const found = embedded ? methodOf(embedded, method, index, depth + 1) : [];
    if (found.length > 0) return found;
  }
  return [];
}

function parseFields(node: GraphNode): Field[] {
  const raw = node.properties.fields;
  if (typeof raw !== "string") return [];
  try {
    return JSON.parse(raw) as Field[];
  } catch {
    return [];
  }
}

function parseList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function packageName(pkg: string): string | null {
  const name = pkg.split("\0")[1];
  return name ? name : null;
}

// The name a package is used by when its clause is unknown: the import
// path's last element, a major version suffix (`/v2`) skipped.
function defaultPackageName(source: string): string {
  const parts = source.split("/");
  const last = parts[parts.length - 1]!;
  return /^v\d+$/u.test(last) && parts.length > 1 ? parts[parts.length - 2]! : last;
}

function nested<V>(map: Map<string, Map<string, V>>, key: string): Map<string, V> {
  let inner = map.get(key);
  if (!inner) {
    inner = new Map();
    map.set(key, inner);
  }
  return inner;
}

// The methods a value's type has (`&server{}` as `{ type: "server" }`, a
// constructor's result as `{ factory: "svc.New" }`): the named ones, own
// or promoted, or else every exported method declared on the type.
export function goValueMethods(
  value: { type?: string; factory?: string },
  fileId: string,
  index: GoCallIndex,
  names?: Iterable<string>,
): Array<{ name: string; functionId: string }> {
  const type = value.type ? resolveType(value.type, fileId, index) : value.factory ? constructedType(value.factory, fileId, index) : null;
  if (!type) return [];
  if (names) {
    return [...names].flatMap((name) => methodOf(type, name, index, 0).slice(0, 1).map((functionId) => ({ name, functionId })));
  }
  return [...index.methodsByPackage.get(type.pkg) ?? []]
    .filter(([key]) => key.startsWith(`${type.name}.`) && /^[A-Z]/u.test(key.slice(type.name.length + 1)))
    .map(([key, functionId]) => ({ name: key.slice(type.name.length + 1), functionId }));
}

// The method names of an interface declared in the package of `fileId`
// (embedded interfaces included), null when it is not one of the scan's.
export function goInterfaceMethodNames(fileId: string, name: string, index: GoCallIndex): Set<string> | null {
  const pkg = index.packageByFile.get(fileId);
  if (pkg === undefined || !index.interfacesByPackage.get(pkg)?.has(name)) return null;
  return interfaceMethods({ pkg, name }, index, 0);
}

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
  fileByFunctionId: Map<string, string>;
  // Imported packages per file by local name; `.` imports under ".".
  importsByFile: Map<string, Map<string, string[]>>;
};

type TypeRef = { pkg: string; name: string };

type Field = { name: string; type: string; embedded?: true };

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
    fileByFunctionId: relationshipIndex.fileByFunctionId,
    importsByFile: new Map(),
  };

  const targetsByImport = new Map<string, string[]>();
  for (const relationship of graph.relationships) {
    if (relationship.type !== "RESOLVES_TO" || !isGoFile(relationship.from.split(":import:")[0]!)) continue;
    targetsByImport.set(relationship.from, [...targetsByImport.get(relationship.from) ?? [], relationship.to]);
  }

  for (const node of graph.nodes) {
    if (node.label === "Function") {
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

  return index;
}

// The function a call made in `callerFileId` reaches, or null when it is
// not one of the scan's (the standard library, a dependency) or its
// receiver's type is unknown.
export function resolveGoCall(call: GraphNode, callerFileId: string, index: GoCallIndex): string | null {
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
  return type ? methodOf(type, callee, index, 0) : null;
}

// `*db.Store`, `Store[T]` → the package and name of the type.
function resolveType(text: string, fileId: string, index: GoCallIndex): TypeRef | null {
  const base = text.replace(/^\*/u, "").replace(/\[.*$/u, "");
  if (!/^[\w.]+$/u.test(base)) return null;
  const [qualifier, name] = base.includes(".") ? base.split(".") : [null, base];
  if (!name) return null;
  if (qualifier === null) {
    const pkg = index.packageByFile.get(fileId);
    if (pkg !== undefined && index.typesByPackage.get(pkg)?.has(name)) return { pkg, name };
    for (const dotPackage of index.importsByFile.get(fileId)?.get(".") ?? []) {
      if (index.typesByPackage.get(dotPackage)?.has(name)) return { pkg: dotPackage, name };
    }
    return pkg === undefined ? null : { pkg, name };
  }
  const targets = index.importsByFile.get(fileId)?.get(qualifier) ?? [];
  const pkg = targets.find((target) => index.typesByPackage.get(target)?.has(name)) ?? targets[0];
  return pkg === undefined ? null : { pkg, name };
}

// `x := NewStore()` / `store.New()`: the type the constructor returns first.
function constructedType(constructor: string, fileId: string, index: GoCallIndex): TypeRef | null {
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

// `(*Store, error)` → `*Store`; `(s *Store, err error)` → `*Store`.
function firstResultType(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const first = raw.replace(/^\(\s*/u, "").replace(/\s*\)$/u, "").split(",")[0]!.trim();
  const parts = first.split(/\s+/u);
  return parts[parts.length - 1] || null;
}

function fieldType(type: TypeRef, field: string, index: GoCallIndex): TypeRef | null {
  const owner = index.typesByPackage.get(type.pkg)?.get(type.name);
  if (!owner) return null;
  const found = parseFields(owner.node).find((candidate) => candidate.name === field);
  return found ? resolveType(found.type, owner.fileId, index) : null;
}

// A method of the type itself or promoted from a field it embeds.
function methodOf(type: TypeRef, method: string, index: GoCallIndex, depth: number): string | null {
  const own = index.methodsByPackage.get(type.pkg)?.get(`${type.name}.${method}`);
  if (own || depth > 3) return own ?? null;
  const owner = index.typesByPackage.get(type.pkg)?.get(type.name);
  if (!owner) return null;
  for (const field of parseFields(owner.node)) {
    if (!field.embedded) continue;
    const embedded = resolveType(field.type, owner.fileId, index);
    const found = embedded ? methodOf(embedded, method, index, depth + 1) : null;
    if (found) return found;
  }
  return null;
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

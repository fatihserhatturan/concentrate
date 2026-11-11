import type { IGraphContributor } from "../../contracts/graph-contributor.js";
import type { GraphNode } from "../../graph/model.js";
import type { ResolutionRelationshipIndex } from "./indexes.js";
import { isRustFile } from "./file-kind.js";
import { rustBaseType, unwrapResultType } from "./rust-types.js";

// Rust calls resolve through names, not through files: the module a file is
// (`rustCrate` / `rustModule`, written by import resolution), the items of
// each file, and what its `use` and `mod` declarations bind.
type Entity =
  | { kind: "fn"; ids: string[]; via?: "trait" }
  | { kind: "module"; file: string }
  | { kind: "type"; type: TypeEntity };

type TypeEntity = { kind: "class" | "enum" | "trait" | "alias"; name: string; node: GraphNode; fileId: string; crate: string | null };

type Binding = { name: string; last: string; target: string | null; wildcard: boolean; isModule: boolean };

type MethodEntry = { id: string; fileId: string; trait: string | null; node: GraphNode };

export type RustCallIndex = {
  crateByFile: Map<string, string | null>;
  moduleByFile: Map<string, string>;
  moduleFile: Map<string, string>;
  crateByName: Map<string, string>;
  freeFunctions: Map<string, Map<string, string[]>>;
  macrosByCrate: Map<string, Map<string, string>>;
  typesByFile: Map<string, Map<string, TypeEntity>>;
  typesByCrate: Map<string, TypeEntity[]>;
  bindingsByFile: Map<string, Binding[]>;
  methods: Map<string, Map<string, MethodEntry[]>>;
  traitDefaults: Map<string, Map<string, string[]>>;
  traitImpls: Map<string, Map<string, string[]>>;
  // Methods of a repository trait implemented for a type that is not the repository's (an extension trait, `impl<T, E> ResultExt<T> for Result<T, E>`), by method name.
  extensionMethods: Map<string, string[]>;
  functionsById: Map<string, GraphNode>;
  fileByFunctionId: Map<string, string>;
};

export type RustCallTarget = { functionId: string; via?: "trait" };

const MAX_DEPTH = 6;

export function createRustCallIndex(graph: IGraphContributor, relationshipIndex: ResolutionRelationshipIndex): RustCallIndex {
  const index: RustCallIndex = {
    crateByFile: new Map(),
    moduleByFile: new Map(),
    moduleFile: new Map(),
    crateByName: new Map(),
    freeFunctions: new Map(),
    macrosByCrate: new Map(),
    typesByFile: new Map(),
    typesByCrate: new Map(),
    bindingsByFile: new Map(),
    methods: new Map(),
    traitDefaults: new Map(),
    traitImpls: new Map(),
    extensionMethods: new Map(),
    functionsById: new Map(),
    fileByFunctionId: relationshipIndex.fileByFunctionId,
  };

  for (const node of graph.nodes) {
    if (node.label !== "File" || !isRustFile(node.id)) continue;
    const crate = typeof node.properties.rustCrate === "string" ? node.properties.rustCrate : null;
    index.crateByFile.set(node.id, crate);
    if (crate === null) continue;
    const module = String(node.properties.rustModule ?? "");
    index.moduleByFile.set(node.id, module);
    if (!index.moduleFile.has(`${crate}\0${module}`)) index.moduleFile.set(`${crate}\0${module}`, node.id);
    const crateName = String(node.properties.rustCrateName ?? "");
    if (crateName !== "" && module === "" && !index.crateByName.has(crateName)) index.crateByName.set(crateName, crate);
  }

  const fileByEnumId = new Map<string, string>();
  const fileByAliasId = new Map<string, string>();
  for (const relationship of graph.relationships) {
    if (relationship.type === "DEFINES_ENUM") fileByEnumId.set(relationship.to, relationship.from);
    else if (relationship.type === "DEFINES_TYPE_ALIAS") fileByAliasId.set(relationship.to, relationship.from);
  }

  const addType = (kind: TypeEntity["kind"], node: GraphNode, fileId: string | undefined) => {
    if (!fileId || !isRustFile(fileId)) return;
    const entity: TypeEntity = { kind, name: String(node.properties.name), node, fileId, crate: index.crateByFile.get(fileId) ?? null };
    const byName = index.typesByFile.get(fileId) ?? new Map<string, TypeEntity>();
    if (!byName.has(entity.name)) byName.set(entity.name, entity);
    index.typesByFile.set(fileId, byName);
    const key = `${entity.crate}\0${entity.name}`;
    index.typesByCrate.set(key, [...index.typesByCrate.get(key) ?? [], entity]);
  };

  for (const node of graph.nodes) {
    if (node.label === "Class") addType("class", node, relationshipIndex.fileByClassId.get(node.id));
    else if (node.label === "Interface") addType("trait", node, relationshipIndex.fileByInterfaceId.get(node.id));
    else if (node.label === "Enum") addType("enum", node, fileByEnumId.get(node.id));
    else if (node.label === "TypeAlias") addType("alias", node, fileByAliasId.get(node.id));
  }

  for (const node of graph.nodes) {
    if (node.label !== "Function") continue;
    const fileId = relationshipIndex.fileByFunctionId.get(node.id);
    if (!fileId || !isRustFile(fileId)) continue;
    index.functionsById.set(node.id, node);
    const crate = index.crateByFile.get(fileId) ?? null;
    const name = String(node.properties.name);
    const className = typeof node.properties.className === "string" ? node.properties.className : null;
    const trait = typeof node.properties.implementsTrait === "string" ? node.properties.implementsTrait : null;
    if (className === null) {
      nested(index.freeFunctions, fileId).set(name, [...nested(index.freeFunctions, fileId).get(name) ?? [], node.id]);
      if (node.properties.kind === "macro_rules") {
        const macros = index.macrosByCrate.get(String(crate)) ?? new Map<string, string>();
        if (!macros.has(name)) macros.set(name, node.id);
        index.macrosByCrate.set(String(crate), macros);
      }
    } else if (node.properties.methodKind === "trait-default") {
      nested(index.traitDefaults, className).set(name, [...nested(index.traitDefaults, className).get(name) ?? [], node.id]);
    } else {
      const methods = nested(index.methods, `${crate}\0${className}`);
      methods.set(name, [...methods.get(name) ?? [], { id: node.id, fileId, trait, node }]);
      if (trait) nested(index.traitImpls, trait).set(name, [...nested(index.traitImpls, trait).get(name) ?? [], node.id]);
    }
  }

  const repositoryTraits = new Set<string>();
  for (const entities of index.typesByFile.values()) {
    for (const entity of entities.values()) if (entity.kind === "trait") repositoryTraits.add(entity.name);
  }
  for (const methods of index.methods.values()) {
    for (const [name, entries] of methods) {
      for (const entry of entries) {
        const className = String(entry.node.properties.className);
        if (entry.trait === null || !repositoryTraits.has(entry.trait)) continue;
        if ([...index.typesByFile.values()].some((types) => { const type = types.get(className); return type !== undefined && type.kind !== "alias"; })) continue;
        index.extensionMethods.set(name, [...index.extensionMethods.get(name) ?? [], entry.id]);
      }
    }
  }

  const targetByImport = relationshipIndex.resolvedFileByImportId;
  for (const node of graph.nodes) {
    if (node.label !== "Import") continue;
    const fileId = relationshipIndex.fileByImportId.get(node.id);
    if (!fileId || !isRustFile(fileId)) continue;
    const source = String(node.properties.source);
    const last = source.split("::").at(-1)!;
    const alias = typeof node.properties.alias === "string" ? node.properties.alias : null;
    const list = index.bindingsByFile.get(fileId) ?? [];
    list.push({
      name: alias ?? last,
      last,
      target: targetByImport.get(node.id) ?? null,
      wildcard: node.properties.isWildcard === true,
      isModule: node.properties.isModule === true,
    });
    index.bindingsByFile.set(fileId, list);
  }

  return index;
}

export function resolveRustCall(call: GraphNode, callerFileId: string, callerFunctionId: string | undefined, index: RustCallIndex): RustCallTarget[] {
  const found = resolveTargets(call, callerFileId, callerFunctionId, index);
  return found.ids.map((functionId) => ({ functionId, ...found.via ? { via: found.via } : {} }));
}

type Found = { ids: string[]; via?: "trait" };
const none: Found = { ids: [] };

function resolveTargets(call: GraphNode, callerFileId: string, callerFunctionId: string | undefined, index: RustCallIndex): Found {
  const callee = call.properties.callee;
  const expression = String(call.properties.expression ?? "");
  if (typeof callee !== "string") return none;
  const caller = callerFunctionId ? index.functionsById.get(callerFunctionId) : undefined;
  const callerClass = typeof caller?.properties.className === "string" ? caller.properties.className : null;
  const receiver = call.properties.receiver;

  // `name!(…)`: a macro, found like a function, or a `#[macro_export]` of the crate.
  if (expression.endsWith("!")) {
    const segments = expression.slice(0, -1).split("::");
    const entity = resolveSegments(segments, callerFileId, callerClass, index, "macro");
    if (entity?.kind === "fn") return entityTargets(entity);
    const crate = index.crateByFile.get(callerFileId);
    const macro = crate === undefined ? undefined : index.macrosByCrate.get(String(crate))?.get(callee);
    return macro ? { ids: [macro] } : none;
  }

  if (typeof receiver !== "string") {
    // A bare name the function itself binds (a closure parameter) is not an item.
    if (call.properties.receiverIsLocal === true) return none;
    const entity = resolveSegments(expression.split("::"), callerFileId, callerClass, index, "value");
    return entityTargets(entity);
  }

  // A method call: the receiver's type decides. A chain's result is untyped, but a
  // method only an extension trait of the repository gives (to a type outside it) is
  // that trait's.
  const extension = index.extensionMethods.get(callee);
  if (/[()[\]?]/u.test(receiver)) return extension ? { ids: [...new Set(extension)], via: "trait" } : none;
  const [, ...fields] = receiver.split(".");
  let types: TypeEntity[] = [];
  if (typeof call.properties.receiverType === "string") {
    types = typesNamed(call.properties.receiverType, callerFileId, index);
  } else if (typeof call.properties.receiverConstructor === "string") {
    types = constructedTypes(call.properties.receiverConstructor, callerFileId, callerClass, index);
  }
  for (const field of fields) {
    types = types.flatMap((type) => fieldTypes(type, field, index));
  }
  const results: Found[] = types.map((type) => methodsOfType(type, callee, index, 0));
  if (types.length === 0 && call.properties.receiverIsLocal !== true && extension) return { ids: [...new Set(extension)], via: "trait" };
  const ids = [...new Set(results.flatMap((result) => result.ids))];
  const via = results.some((result) => result.via === "trait") ? "trait" as const : undefined;
  return { ids, ...via ? { via } : {} };
}

function entityTargets(entity: Entity | null): Found {
  return entity?.kind === "fn" ? { ids: entity.ids, ...entity.via ? { via: entity.via } : {} } : none;
}

// A path of `a::b::f` or `Type::method` or a single name, from the file it is written in.
function resolveSegments(segments: string[], fileId: string, className: string | null, index: RustCallIndex, _ns: "value" | "macro"): Entity | null {
  const crate = index.crateByFile.get(fileId) ?? null;
  const last = segments.length - 1;
  let current: Entity | null = null;
  let position = 0;
  const first = segments[0]!;

  if (first === "crate") {
    const root = crate === null ? undefined : index.moduleFile.get(`${crate}\0`);
    if (!root) return null;
    current = { kind: "module", file: root };
    position = 1;
  } else if (first === "self" || first === "super") {
    let module = index.moduleByFile.get(fileId);
    if (module === undefined || crate === null) return null;
    while (segments[position] === "self" || segments[position] === "super") {
      if (segments[position] === "super") {
        if (module === "") return null;
        module = module.split("::").slice(0, -1).join("::");
      }
      position += 1;
    }
    const file = index.moduleFile.get(`${crate}\0${module}`);
    if (!file) return null;
    current = { kind: "module", file };
  } else if (first === "Self") {
    if (!className) return null;
    const type = typeNamed(className, fileId, index);
    if (!type) return null;
    current = { kind: "type", type };
    position = 1;
  } else if (segments.length === 1) {
    return lookup(fileId, first, "value", 0, new Set(), index);
  } else {
    current = lookup(fileId, first, "type", 0, new Set(), index);
    if (!current) {
      const external = index.crateByName.get(first);
      const root = external === undefined ? undefined : index.moduleFile.get(`${external}\0`);
      if (!root) return null;
      current = { kind: "module", file: root };
    }
    position = 1;
  }

  for (; position < segments.length; position += 1) {
    const segment = segments[position]!;
    const isLast = position === last;
    if (current.kind === "module") {
      const next: Entity | null = lookup(current.file, segment, isLast ? "value" : "type", 0, new Set(), index);
      if (!next) return null;
      current = next;
    } else if (current.kind === "type") {
      if (!isLast) return null;
      const found = methodsOfType(current.type, segment, index, 0);
      return found.ids.length > 0 ? { kind: "fn", ids: found.ids, ...found.via ? { via: found.via } : {} } : null;
    } else {
      return null;
    }
  }
  return current;
}

function lookup(fileId: string, name: string, ns: "value" | "type", depth: number, seen: Set<string>, index: RustCallIndex): Entity | null {
  const key = `${fileId}\0${name}\0${ns}`;
  if (depth > MAX_DEPTH || seen.has(key)) return null;
  seen.add(key);
  if (ns === "value") {
    const ids = index.freeFunctions.get(fileId)?.get(name);
    if (ids && ids.length > 0) return { kind: "fn", ids };
  } else {
    const type = index.typesByFile.get(fileId)?.get(name);
    if (type) return { kind: "type", type };
  }
  const bindings = index.bindingsByFile.get(fileId) ?? [];
  for (const binding of bindings) {
    if (binding.wildcard || binding.name !== name || !binding.target) continue;
    if (binding.isModule) {
      if (ns === "type") return { kind: "module", file: binding.target };
      continue;
    }
    const targetModule = index.moduleByFile.get(binding.target);
    const moduleName = targetModule?.split("::").at(-1);
    if (ns === "type" && binding.target !== fileId && moduleName === binding.last) return { kind: "module", file: binding.target };
    const found = lookup(binding.target, binding.last, ns, depth + 1, seen, index);
    if (found) return found;
  }
  for (const binding of bindings) {
    if (!binding.wildcard || !binding.target || binding.target === fileId) continue;
    const found = lookup(binding.target, name, ns, depth + 1, seen, index);
    if (found) return found;
  }
  return null;
}

// A type by the name a signature or a `let` writes: the file's own and imported
// types first, else the only type of that name in the crate.
function typeNamed(name: string, fileId: string, index: RustCallIndex): TypeEntity | null {
  const entity = lookup(fileId, name, "type", 0, new Set(), index);
  if (entity?.kind === "type") return entity.type;
  const candidates = index.typesByCrate.get(`${index.crateByFile.get(fileId) ?? null}\0${name}`) ?? [];
  return candidates.length === 1 ? candidates[0]! : null;
}

// `A+B` (a type parameter's bounds) is several types.
function typesNamed(names: string, fileId: string, index: RustCallIndex): TypeEntity[] {
  return names.split("+").map((name) => typeNamed(name, fileId, index)).filter((type): type is TypeEntity => type !== null);
}

function constructedTypes(constructor: string, fileId: string, className: string | null, index: RustCallIndex): TypeEntity[] {
  const unwrap = constructor.endsWith("?");
  const segments = (unwrap ? constructor.slice(0, -1) : constructor).split("::");
  const entity = resolveSegments(segments, fileId, className, index, "value");
  if (entity?.kind !== "fn") {
    // A tuple struct (`Meters(1.0)`) or an enum variant (`Kind::Admin(1)`) is a value of its type.
    const type = segments.length === 1 ? typeNamed(segments[0]!, fileId, index) : segments.length === 2 ? typeNamed(segments[0]!, fileId, index) : null;
    const isVariant = type !== null && segments.length === 2 && type.kind === "enum";
    return type !== null && (segments.length === 1 || isVariant) ? [type] : [];
  }
  const types: TypeEntity[] = [];
  for (const id of entity.ids.slice(0, 1)) {
    const fn = index.functionsById.get(id);
    const returnType = fn?.properties.returnType;
    const functionFile = index.fileByFunctionId.get(id);
    if (!fn || typeof returnType !== "string" || !functionFile) continue;
    const selfType = typeof fn.properties.className === "string" ? fn.properties.className : null;
    const name = unwrap ? unwrapResultType(returnType, selfType) : rustBaseType(returnType, new Map(), selfType);
    if (name) types.push(...typesNamed(name, functionFile, index));
  }
  return types;
}

function fieldTypes(type: TypeEntity, field: string, index: RustCallIndex): TypeEntity[] {
  const resolved = resolveAlias(type, index, 0);
  if (resolved.kind !== "class" || typeof resolved.node.properties.fields !== "string") return [];
  let fields: Array<{ name: string; type: string }> = [];
  try {
    fields = JSON.parse(resolved.node.properties.fields);
  } catch {
    return [];
  }
  const entry = fields.find((candidate) => candidate.name === field);
  const name = entry ? rustBaseType(entry.type, new Map(), resolved.name) : null;
  return name ? typesNamed(name, resolved.fileId, index) : [];
}

function resolveAlias(type: TypeEntity, index: RustCallIndex, depth: number): TypeEntity {
  if (type.kind !== "alias" || depth > MAX_DEPTH) return type;
  const aliasOf = typeof type.node.properties.aliasOf === "string" ? type.node.properties.aliasOf : null;
  const name = aliasOf ? rustBaseType(aliasOf) : null;
  const target = name ? typeNamed(name, type.fileId, index) : null;
  return target && target !== type ? resolveAlias(target, index, depth + 1) : type;
}

// A method of a type: its own (inherent and trait impls) and the default
// methods of the traits it implements; on a trait (a `dyn`, `impl` or bounded
// parameter), the default and every implementation, marked `trait`.
function methodsOfType(type: TypeEntity, name: string, index: RustCallIndex, depth: number): Found {
  const resolved = resolveAlias(type, index, depth);
  if (resolved.kind === "trait") {
    const ids = [...index.traitDefaults.get(resolved.name)?.get(name) ?? [], ...index.traitImpls.get(resolved.name)?.get(name) ?? []];
    // Methods of a supertrait.
    if (ids.length === 0) {
      for (const supertrait of supertraits(resolved)) {
        const target = typeNamed(supertrait, resolved.fileId, index);
        if (target && target.kind === "trait" && depth < MAX_DEPTH) {
          const inherited = methodsOfType(target, name, index, depth + 1);
          if (inherited.ids.length > 0) return inherited;
        }
      }
    }
    return { ids: [...new Set(ids)], via: "trait" };
  }
  const entries = index.methods.get(`${resolved.crate}\0${resolved.name}`)?.get(name) ?? [];
  const duplicates = (index.typesByCrate.get(`${resolved.crate}\0${resolved.name}`) ?? []).length > 1;
  const own = entries.filter((entry) => !duplicates || entry.fileId === resolved.fileId);
  if (own.length > 0) return { ids: own.map((entry) => entry.id) };
  // A default method of a trait the type implements.
  const traits = new Set([...index.methods.get(`${resolved.crate}\0${resolved.name}`)?.values() ?? []].flat().map((entry) => entry.trait).filter((trait): trait is string => trait !== null));
  const defaults = [...traits].flatMap((trait) => index.traitDefaults.get(trait)?.get(name) ?? []);
  return { ids: defaults };
}

function supertraits(trait: TypeEntity): string[] {
  try {
    return JSON.parse(String(trait.node.properties.embeds ?? "[]")) as string[];
  } catch {
    return [];
  }
}

function nested<K, V>(map: Map<K, Map<string, V>>, key: K): Map<string, V> {
  let inner = map.get(key);
  if (!inner) {
    inner = new Map();
    map.set(key, inner);
  }
  return inner;
}

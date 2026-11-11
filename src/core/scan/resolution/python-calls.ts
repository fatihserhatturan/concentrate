import type { IGraphContributor } from "../../contracts/graph-contributor.js";
import type { GraphNode } from "../../graph/model.js";
import type { ResolutionRelationshipIndex } from "./indexes.js";
import { indexImportNodesByFile } from "./indexes.js";
import { createPythonNameLookup, type PythonNameLookup } from "./python-names.js";

// Python calls resolve through names and types, never by guessing:
//   f()               a function of the file or one imported (aliases, re-exports)
//   Foo()             the `__init__` of the class (own or inherited)
//   mod.f(), pkg.mod.f()   through the module the import names
//   Foo.method()      a method of the class
//   self.m(), cls.m() the method of the enclosing class or its bases
//   super().m()       the method of a base
//   x.m()             `x` an annotated parameter or variable, or the result
//                     of a constructor or an annotated function
//   self.a.m()        `a` an attribute whose type the class declares (a field,
//                     an annotated `self.a: T`, an `__init__` parameter, a constructor)
// A call through a class reaches the overrides in its subclasses too, marked
// `via: "override"`. A call that none of this resolves stays unresolved.

type Owner = { id: string; node: GraphNode; fileId: string };
type Attribute = { type: string } | { constructedBy: string };

export type PythonCallTarget = { functionId: string; via?: "override" };

export type PythonCallIndex = {
  lookupFunction: PythonNameLookup;
  lookupType: PythonNameLookup;
  lookupVariable: PythonNameLookup;
  owners: Map<string, Owner>;
  methods: Map<string, Map<string, string[]>>;
  supers: Map<string, string[]>;
  subs: Map<string, string[]>;
  functionsById: Map<string, GraphNode>;
  fileByFunctionId: Map<string, string>;
  variablesById: Map<string, GraphNode>;
  fileByVariableId: Map<string, string>;
  classByFileAndName: Map<string, Map<string, string>>;
};

export function createPythonCallIndex(graph: IGraphContributor, relationshipIndex: ResolutionRelationshipIndex): PythonCallIndex {
  const functionsById = new Map<string, GraphNode>();
  const variablesById = new Map<string, GraphNode>();
  const fileByVariableId = new Map<string, string>();
  for (const rel of graph.relationships) if (rel.type === "DEFINES_VARIABLE") fileByVariableId.set(rel.to, rel.from);

  const freeFunctions = new Map<string, Map<string, string[]>>();
  const types = new Map<string, Map<string, string[]>>();
  const variables = new Map<string, Map<string, string[]>>();
  const owners = new Map<string, Owner>();
  const classByFileAndName = new Map<string, Map<string, string>>();
  const add = (map: Map<string, Map<string, string[]>>, file: string, name: string, id: string) => {
    const byName = map.get(file) ?? new Map<string, string[]>();
    byName.set(name, [...byName.get(name) ?? [], id]);
    map.set(file, byName);
  };

  for (const node of graph.nodes) {
    const name = String(node.properties.name ?? "");
    if (node.label === "Function") {
      const file = relationshipIndex.fileByFunctionId.get(node.id);
      if (!file?.endsWith(".py")) continue;
      functionsById.set(node.id, node);
      if (node.properties.className === null) add(freeFunctions, file, name, node.id);
    } else if (node.label === "Class" || node.label === "Interface") {
      const file = (node.label === "Class" ? relationshipIndex.fileByClassId : relationshipIndex.fileByInterfaceId).get(node.id);
      if (!file?.endsWith(".py")) continue;
      owners.set(node.id, { id: node.id, node, fileId: file });
      add(types, file, name, node.id);
      const byName = classByFileAndName.get(file) ?? new Map<string, string>();
      if (!byName.has(name)) byName.set(name, node.id);
      classByFileAndName.set(file, byName);
    } else if (node.label === "Variable") {
      const file = fileByVariableId.get(node.id);
      if (!file?.endsWith(".py")) continue;
      variablesById.set(node.id, node);
      add(variables, file, name, node.id);
    }
  }

  const methods = new Map<string, Map<string, string[]>>();
  const addMethod = (ownerId: string, name: string, id: string) => {
    const byName = methods.get(ownerId) ?? new Map<string, string[]>();
    byName.set(name, [...byName.get(name) ?? [], id]);
    methods.set(ownerId, byName);
  };
  for (const rel of graph.relationships) {
    if (rel.type !== "DEFINES_METHOD" || !owners.has(rel.from)) continue;
    const fn = functionsById.get(rel.to);
    if (fn) addMethod(rel.from, String(fn.properties.name), fn.id);
  }
  // Methods of an interface are functions of the file named after it.
  for (const fn of functionsById.values()) {
    if (fn.properties.methodKind !== "interface-method") continue;
    const file = relationshipIndex.fileByFunctionId.get(fn.id)!;
    const ownerId = classByFileAndName.get(file)?.get(String(fn.properties.className));
    if (ownerId) addMethod(ownerId, String(fn.properties.name), fn.id);
  }

  const supers = new Map<string, string[]>();
  const subs = new Map<string, string[]>();
  for (const rel of graph.relationships) {
    if ((rel.type !== "EXTENDS" && rel.type !== "IMPLEMENTS") || !owners.has(rel.from) || !owners.has(rel.to)) continue;
    supers.set(rel.from, [...supers.get(rel.from) ?? [], rel.to]);
    subs.set(rel.to, [...subs.get(rel.to) ?? [], rel.from]);
  }

  const importsByFile = indexImportNodesByFile(graph.nodes, relationshipIndex.fileByImportId);
  const resolved = relationshipIndex.resolvedFileByImportId;
  return {
    lookupFunction: createPythonNameLookup(freeFunctions, importsByFile, resolved),
    lookupType: createPythonNameLookup(types, importsByFile, resolved),
    lookupVariable: createPythonNameLookup(variables, importsByFile, resolved),
    owners,
    methods,
    supers,
    subs,
    functionsById,
    fileByFunctionId: relationshipIndex.fileByFunctionId,
    variablesById,
    fileByVariableId,
    classByFileAndName,
  };
}

export function resolvePythonCall(
  call: GraphNode,
  callerFileId: string,
  callerFunctionId: string | undefined,
  index: PythonCallIndex,
): PythonCallTarget[] {
  const callee = String(call.properties.callee ?? "");
  const receiver = typeof call.properties.receiver === "string" ? call.properties.receiver : null;
  if (callee === "") return [];
  const caller = callerFunctionId ? index.functionsById.get(callerFunctionId) : undefined;
  const callerClass = caller && typeof caller.properties.className === "string"
    ? index.classByFileAndName.get(callerFileId)?.get(caller.properties.className) ?? null
    : null;

  // `f()`
  if (receiver === null) {
    if (call.properties.receiverIsLocal === true) return [];
    const free = index.lookupFunction(callee, callerFileId);
    if (free) return [{ functionId: free }];
    const typeId = index.lookupType(callee, callerFileId);
    const init = typeId ? findMethod(typeId, "__init__", index) : null;
    return init ? [{ functionId: init.id }] : [];
  }

  if (receiver === "super") {
    if (!callerClass) return [];
    for (const base of index.supers.get(callerClass) ?? []) {
      const found = findMethod(base, callee, index);
      if (found) return [{ functionId: found.id }];
    }
    return [];
  }

  let ownerId: string | null = null;
  const parts = receiver.split(".");
  const root = parts[0]!;

  if ((root === "self" || root === "cls") && call.properties.receiverIsLocal === true) {
    ownerId = callerClass;
  } else if (call.properties.receiverIsLocal === true) {
    if (typeof call.properties.receiverType === "string") ownerId = index.lookupType(call.properties.receiverType, callerFileId);
    else if (typeof call.properties.receiverConstructor === "string") ownerId = typeOfConstruction(call.properties.receiverConstructor, callerFileId, index);
  } else {
    // A module-qualified function (`utils.f()`, `pkg.mod.f()`).
    const qualified = index.lookupFunction(`${receiver}.${callee}`, callerFileId);
    if (qualified) return [{ functionId: qualified }];
    // A class (`Foo.method()`, `models.Foo.method()`).
    ownerId = index.lookupType(receiver, callerFileId);
    if (ownerId) {
      const found = findMethod(ownerId, callee, index);
      return found ? [{ functionId: found.id }] : [];
    }
    // A module-level variable (`repo.save()`).
    const variableId = index.lookupVariable(root, callerFileId);
    const variable = variableId ? index.variablesById.get(variableId) : undefined;
    if (variable && variableId) {
      const file = index.fileByVariableId.get(variableId)!;
      if (typeof variable.properties.typeName === "string") ownerId = index.lookupType(variable.properties.typeName, file);
      else if (typeof variable.properties.constructorName === "string") ownerId = typeOfConstruction(variable.properties.constructorName, file, index);
    }
  }
  if (!ownerId) return [];

  // `self.a.b.m()`: follow the attributes `a`, `b`.
  for (const attribute of parts.slice(1)) {
    ownerId = attributeType(ownerId, attribute, index);
    if (!ownerId) return [];
  }

  const found = findMethod(ownerId, callee, index);
  if (!found) return [];
  const targets: PythonCallTarget[] = [{ functionId: found.id }];
  // A call through a class reaches the overrides of its subclasses.
  for (const override of overridesOf(found.ownerId, callee, index)) {
    if (override !== found.id) targets.push({ functionId: override, via: "override" });
  }
  return targets;
}

// What `Foo(...)` or `make(...)` gives: the class `Foo`, or the class named by the return type of `make`.
function typeOfConstruction(name: string, fileId: string, index: PythonCallIndex): string | null {
  const direct = index.lookupType(name, fileId);
  if (direct) return direct;
  const functionId = index.lookupFunction(name, fileId);
  const fn = functionId ? index.functionsById.get(functionId) : undefined;
  if (!fn || !functionId || typeof fn.properties.returnType !== "string") return null;
  const returned = normalizeReturnType(fn.properties.returnType);
  return returned ? index.lookupType(returned, index.fileByFunctionId.get(functionId)!) : null;
}

function normalizeReturnType(annotation: string): string | null {
  let text = annotation.trim().replace(/^["']|["']$/gu, "").trim();
  const wrapper = /^(?:typing\.)?(?:Optional|Awaitable)\[(.+)\]$/u.exec(text);
  if (wrapper) text = wrapper[1]!.trim();
  const members = text.split("|").map((member) => member.trim()).filter((member) => member !== "None");
  if (members.length === 1) text = members[0]!;
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/u.test(text) && text !== "None" ? text : null;
}

// The class of `attribute` of `ownerId` (or of a base): an `__init__`/method
// assignment, else an annotated field.
function attributeType(ownerId: string, attribute: string, index: PythonCallIndex, seen = new Set<string>()): string | null {
  if (seen.has(ownerId)) return null;
  seen.add(ownerId);
  const owner = index.owners.get(ownerId);
  if (!owner) return null;
  const attributes = parseJson<Record<string, Attribute>>(owner.node.properties.attributes) ?? {};
  const declared = attributes[attribute];
  if (declared) {
    const resolved = "type" in declared ? index.lookupType(declared.type, owner.fileId) : typeOfConstruction(declared.constructedBy, owner.fileId, index);
    if (resolved) return resolved;
  }
  const field = (parseJson<Array<{ name: string; type: string | null }>>(owner.node.properties.fields) ?? []).find((candidate) => candidate.name === attribute);
  if (field?.type) {
    const resolved = index.lookupType(normalizeReturnType(field.type) ?? field.type, owner.fileId);
    if (resolved) return resolved;
  }
  for (const base of index.supers.get(ownerId) ?? []) {
    const found = attributeType(base, attribute, index, seen);
    if (found) return found;
  }
  return null;
}

// The method `name` of a class: its own, else the first base's (depth first, in declaration order).
function findMethod(ownerId: string, name: string, index: PythonCallIndex, seen = new Set<string>()): { id: string; ownerId: string } | null {
  if (seen.has(ownerId)) return null;
  seen.add(ownerId);
  const own = index.methods.get(ownerId)?.get(name)?.[0];
  if (own) return { id: own, ownerId };
  for (const base of index.supers.get(ownerId) ?? []) {
    const found = findMethod(base, name, index, seen);
    if (found) return found;
  }
  return null;
}

function overridesOf(ownerId: string, name: string, index: PythonCallIndex): string[] {
  const found: string[] = [];
  const seen = new Set<string>([ownerId]);
  const queue = [...index.subs.get(ownerId) ?? []];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const own = index.methods.get(current)?.get(name)?.[0];
    if (own) found.push(own);
    queue.push(...index.subs.get(current) ?? []);
  }
  return found;
}

function parseJson<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

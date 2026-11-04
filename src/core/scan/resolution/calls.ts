import type { IGraphContributor } from "../../contracts/graph-contributor.js";
import type { GraphNode } from "../../graph/model.js";
import { resolveCall, resolveDeclaration, resolveImportedFreeCall } from "./call-targets.js";
import { isGoFile } from "./file-kind.js";
import { createGoCallIndex, resolveGoCall, type GoCallIndex } from "./go-calls.js";
import {
  createResolutionRelationshipIndex,
  indexImportNodesByFile,
  indexNodesByFileAndName,
} from "./indexes.js";

export function addCallResolutionRelationships(graph: IGraphContributor): {
  resolved: number;
  unresolved: number;
} {
  const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
  const functionsByFileAndName = indexNodesByFileAndName(
    graph.nodes,
    relationshipIndex.fileByFunctionId,
    "Function",
  );
  const importNodesByFile = indexImportNodesByFile(graph.nodes, relationshipIndex.fileByImportId);
  indexDefaultExports(graph, functionsByFileAndName, importNodesByFile, relationshipIndex.resolvedFileByImportId);
  const classesByFileAndName = indexNodesByFileAndName(graph.nodes, relationshipIndex.fileByClassId, "Class");
  indexDefaultExports(graph, classesByFileAndName, importNodesByFile, relationshipIndex.resolvedFileByImportId);
  const classes: ClassIndex = {
    byFileAndName: classesByFileAndName,
    ...indexClassMembers(graph),
    importNodesByFile,
    resolvedFileByImportId: relationshipIndex.resolvedFileByImportId,
  };
  const scopes = indexScopes(graph, functionsByFileAndName, importNodesByFile);
  let goIndex: GoCallIndex | null = null;

  let resolved = 0;
  let unresolved = 0;

  for (const node of graph.nodes) {
    if (node.label !== "Call") continue;

    const callee = node.properties.callee as string | null;
    const receiver = node.properties.receiver as string | null;
    const requireSource = node.properties.requireSource;
    if (!callee && typeof requireSource !== "string") {
      unresolved++;
      continue;
    }

    // A call is made either inside a function or by a file's top-level code.
    const callerFunctionId = relationshipIndex.callerFunctionByCallId.get(node.id);
    const callerFileId = callerFunctionId
      ? relationshipIndex.fileByFunctionId.get(callerFunctionId)
      : relationshipIndex.callerFileByModuleCallId.get(node.id);
    if (!callerFileId) {
      unresolved++;
      continue;
    }

    if (isGoFile(callerFileId)) {
      goIndex ??= createGoCallIndex(graph, relationshipIndex);
      const targetFunctionId = resolveGoCall(node, callerFileId, goIndex);
      if (targetFunctionId) {
        graph.addRelationship({ from: node.id, to: targetFunctionId, type: "CALL_RESOLVES_TO", properties: {} });
        resolved++;
      } else {
        unresolved++;
      }
      continue;
    }

    if (typeof requireSource === "string" || !callee) {
      const targetFunctionId = typeof requireSource !== "string" ? null : resolveRequiredModuleCall(requireSource, callerFileId, functionsByFileAndName, importNodesByFile, relationshipIndex.resolvedFileByImportId);
      if (targetFunctionId) {
        graph.addRelationship({ from: node.id, to: targetFunctionId, type: "CALL_RESOLVES_TO", properties: {} });
        resolved++;
      } else {
        unresolved++;
      }
      continue;
    }

    if (!receiver && isShadowed(callee, callerFunctionId, callerFileId, scopes)) {
      unresolved++;
      continue;
    }

    // A bare call of an imported name is the import's: a module cannot also
    // declare that name, so a function of the file with it is an object's
    // property (`actions = { logout() { logout() } }`).
    const importedName = !receiver && scopes.importedNamesByFile.get(callerFileId)?.has(callee) === true;
    const targetFunctionId = (importedName
      ? resolveImportedFreeCall(callee, callerFileId, functionsByFileAndName, importNodesByFile, relationshipIndex.resolvedFileByImportId)
      : resolveCall(
        callee,
        receiver,
        callerFileId,
        functionsByFileAndName,
        importNodesByFile,
        relationshipIndex.resolvedFileByImportId,
      )) ?? resolveClassCall(node, callee, receiver, callerFileId, classes);

    if (!targetFunctionId) {
      unresolved++;
      continue;
    }

    graph.addRelationship({
      from: node.id,
      to: targetFunctionId,
      type: "CALL_RESOLVES_TO",
      properties: {},
    });
    resolved++;
  }

  return { resolved, unresolved };
}

type ScopeIndex = {
  functionsByFileAndName: Map<string, Map<string, string[]>>;
  parametersByFunction: Map<string, Set<string>>;
  variableLinesByFileAndName: Map<string, number[]>;
  importedNamesByFile: Map<string, Set<string>>;
  lineByFunction: Map<string, number>;
};

// A bare call `f()` whose name another binding in scope takes: a parameter
// of the calling function (`function run(f) { f() }`), or a file-level
// variable that does not itself declare the function (`var resolve =
// path.resolve`, which hides a `function resolve()` expression assigned to a
// property elsewhere in the file). A variable that an import also binds
// (`const build = require("./x")`) is left to the import lookup.
function isShadowed(callee: string, callerFunctionId: string | undefined, fileId: string, scopes: ScopeIndex): boolean {
  if (callerFunctionId && scopes.parametersByFunction.get(callerFunctionId)?.has(callee)) return true;
  const lines = scopes.variableLinesByFileAndName.get(`${fileId}\0${callee}`);
  if (!lines || scopes.importedNamesByFile.get(fileId)?.has(callee)) return false;
  const functions = scopes.functionsByFileAndName.get(fileId)?.get(callee) ?? [];
  return !functions.some((id) => lines.includes(scopes.lineByFunction.get(id) ?? -1));
}

function indexScopes(
  graph: IGraphContributor,
  functionsByFileAndName: Map<string, Map<string, string[]>>,
  importNodesByFile: Map<string, GraphNode[]>,
): ScopeIndex {
  const parametersByFunction = new Map<string, Set<string>>();
  const lineByFunction = new Map<string, number>();
  const variables = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (node.label === "Variable") variables.set(node.id, node);
    if (node.label !== "Function") continue;
    lineByFunction.set(node.id, Number(node.properties.line));
    const names = parameterNames(node.properties.parameters);
    if (names.size > 0) parametersByFunction.set(node.id, names);
  }

  const variableLinesByFileAndName = new Map<string, number[]>();
  for (const relationship of graph.relationships) {
    if (relationship.type !== "DEFINES_VARIABLE") continue;
    const variable = variables.get(relationship.to);
    const name = variable?.properties.name;
    if (typeof name !== "string" || variable!.properties.kind === "export_default") continue;
    const key = `${relationship.from}\0${name}`;
    variableLinesByFileAndName.set(key, [...variableLinesByFileAndName.get(key) ?? [], Number(variable!.properties.line)]);
  }

  const importedNamesByFile = new Map<string, Set<string>>();
  for (const [fileId, imports] of importNodesByFile) {
    const names = new Set<string>();
    for (const importNode of imports) {
      const raw = importNode.properties.bindings;
      if (typeof raw !== "string") continue;
      for (const binding of JSON.parse(raw) as Array<{ local?: unknown }>) {
        if (typeof binding.local === "string") names.add(binding.local);
      }
    }
    if (names.size > 0) importedNamesByFile.set(fileId, names);
  }

  return { functionsByFileAndName, parametersByFunction, variableLinesByFileAndName, importedNamesByFile, lineByFunction };
}

function parameterNames(raw: unknown): Set<string> {
  if (typeof raw !== "string") return new Set();
  try {
    const parameters = JSON.parse(raw) as Array<{ name?: unknown }>;
    return new Set(parameters.flatMap((parameter) => typeof parameter.name === "string" ? [parameter.name] : []));
  } catch {
    return new Set();
  }
}

// `require("./x")(...)`: the function the required file exports as a whole
// (`module.exports = fn`), found through the file's import of that module.
function resolveRequiredModuleCall(
  source: string,
  fileId: string,
  functionsByFileAndName: Map<string, Map<string, string[]>>,
  importNodesByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): string | null {
  for (const importNode of importNodesByFile.get(fileId) ?? []) {
    if (importNode.properties.isCjs !== true || importNode.properties.source !== source) continue;
    const targetFileId = resolvedFileByImportId.get(importNode.id);
    if (!targetFileId) continue;
    const found = resolveDeclaration("default", targetFileId, functionsByFileAndName, importNodesByFile, resolvedFileByImportId);
    if (found) return found;
  }
  return null;
}

type ClassIndex = {
  byFileAndName: Map<string, Map<string, string[]>>;
  methodsByClass: Map<string, Map<string, string>>;
  baseClassesByClass: Map<string, string[]>;
  importNodesByFile: Map<string, GraphNode[]>;
  resolvedFileByImportId: Map<string, string>;
};

// Calls that go through a class rather than a function: `new X(...)` runs
// X's constructor, and `X.method(...)` with X a class runs its static
// method. Both are looked up on the class and then its base classes. A class
// without a constructor anywhere in its chain leaves `new X()` unresolved,
// since CALL_RESOLVES_TO points at functions.
function resolveClassCall(call: GraphNode, callee: string, receiver: string | null, fileId: string, classes: ClassIndex): string | null {
  const expression = call.properties.expression;
  const isNew = typeof expression === "string" && expression.startsWith("new ");
  if (isNew ? receiver !== null : !receiver || receiver === "this" || receiver === "self" || receiver.includes(".")) return null;

  const classId = resolveDeclaration(isNew ? callee : receiver!, fileId, classes.byFileAndName, classes.importNodesByFile, classes.resolvedFileByImportId);
  return classId ? findMethod(classId, isNew ? "constructor" : callee, classes, new Set()) : null;
}

function findMethod(classId: string, name: string, classes: ClassIndex, visited: Set<string>): string | null {
  if (visited.has(classId)) return null;
  visited.add(classId);
  const own = classes.methodsByClass.get(classId)?.get(name);
  if (own) return own;
  for (const baseId of classes.baseClassesByClass.get(classId) ?? []) {
    const inherited = findMethod(baseId, name, classes, visited);
    if (inherited) return inherited;
  }
  return null;
}

function indexClassMembers(graph: IGraphContributor): Pick<ClassIndex, "methodsByClass" | "baseClassesByClass"> {
  const namesById = new Map<string, unknown>();
  for (const node of graph.nodes) {
    if (node.label === "Function") namesById.set(node.id, node.properties.name);
  }
  const methodsByClass = new Map<string, Map<string, string>>();
  const baseClassesByClass = new Map<string, string[]>();
  for (const relationship of graph.relationships) {
    if (relationship.type === "DEFINES_METHOD") {
      const name = namesById.get(relationship.to);
      if (typeof name !== "string") continue;
      let methods = methodsByClass.get(relationship.from);
      if (!methods) methodsByClass.set(relationship.from, methods = new Map());
      if (!methods.has(name)) methods.set(name, relationship.to);
    } else if (relationship.type === "EXTENDS") {
      baseClassesByClass.set(relationship.from, [...baseClassesByClass.get(relationship.from) ?? [], relationship.to]);
    }
  }
  return { methodsByClass, baseClassesByClass };
}

// A file whose default export is one of its functions (or classes) also
// lists it under the name "default", so default imports and
// `export { default } from` re-exports resolve like named ones. When the
// exported name is a module-level variable (`const ky = createInstance()`),
// a same-named function counts only if that variable declares it, so a
// nested function of the same name is never picked.
function indexDefaultExports(
  graph: IGraphContributor,
  declarationsByFileAndName: Map<string, Map<string, string[]>>,
  importNodesByFile: Map<string, GraphNode[]>,
  resolvedFileByImportId: Map<string, string>,
): void {
  const defaults = new Map<string, string>();
  const forwards = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.label !== "File") continue;
    if (typeof node.properties.defaultExport === "string") defaults.set(node.id, node.properties.defaultExport);
    if (typeof node.properties.defaultExportFrom === "string") forwards.set(node.id, node.properties.defaultExportFrom);
  }
  indexOwnDefaults(graph, declarationsByFileAndName, defaults);

  // `module.exports = require("./x")` exports x's default, through chains.
  for (let changed = forwards.size > 0; changed;) {
    changed = false;
    for (const [fileId, source] of forwards) {
      if (declarationsByFileAndName.get(fileId)?.has("default")) continue;
      const importNode = importNodesByFile.get(fileId)?.find((node) => node.properties.isCjs === true && node.properties.source === source);
      const targetFileId = importNode ? resolvedFileByImportId.get(importNode.id) : undefined;
      const target = targetFileId ? declarationsByFileAndName.get(targetFileId)?.get("default") : undefined;
      if (!target) continue;
      let declarations = declarationsByFileAndName.get(fileId);
      if (!declarations) declarationsByFileAndName.set(fileId, declarations = new Map());
      declarations.set("default", target);
      changed = true;
    }
  }
}

function indexOwnDefaults(
  graph: IGraphContributor,
  declarationsByFileAndName: Map<string, Map<string, string[]>>,
  defaults: Map<string, string>,
): void {
  if (defaults.size === 0) return;

  const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
  const variableLines = new Map<string, number[]>();
  for (const relationship of graph.relationships) {
    if (relationship.type !== "DEFINES_VARIABLE") continue;
    const variable = nodesById.get(relationship.to);
    if (variable?.properties.name !== defaults.get(relationship.from)) continue;
    const key = `${relationship.from}\0${variable!.properties.name}`;
    variableLines.set(key, [...variableLines.get(key) ?? [], Number(variable!.properties.line)]);
  }

  for (const [fileId, name] of defaults) {
    const functions = declarationsByFileAndName.get(fileId);
    if (!functions || functions.has("default")) continue;
    const lines = variableLines.get(`${fileId}\0${name}`);
    const targets = (functions.get(name) ?? []).filter((id) => !lines || lines.includes(Number(nodesById.get(id)?.properties.line)));
    if (targets.length > 0) functions.set("default", targets);
  }
}

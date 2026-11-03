import type { IGraphContributor } from "../../../../core/contracts/graph-contributor.js";
import type { GraphNode } from "../../../../core/graph/model.js";
import { createResolutionRelationshipIndex, indexImportNodesByFile } from "../../../../core/scan/resolution/indexes.js";

// Packages whose default export copies one object's members onto another.
const MIXIN_PACKAGES = new Set(["merge-descriptors", "utils-merge"]);

type Mixin = { target: string; moduleFileId: string };

// Factories that mix a module into the object they build, as Express does:
//
//   var proto = require('./application');
//   function createApplication() { var app = …; mixin(app, proto, false); … return app; }
//   var app = express();   // express is createApplication
//   app.listen(3000);      // resolves to `app.listen = function listen` in application.js
//
// A mixin call is `mixin(target, source)` with `mixin` imported from a mixin
// package, or `Object.assign(target, source)`, where `source` is a binding
// the factory's file imports from a scanned file. Calls on the target inside
// the factory (and functions nested in it), and on a file-level variable
// initialized by calling the factory, resolve to the module-level function
// of that file with the called name. A parameter of the calling function
// with the receiver's name hides it, and calls that already resolve are kept.
export function addMixinMethodResolutionRelationships(graph: IGraphContributor): void {
  const index = createResolutionRelationshipIndex(graph.relationships);
  const importsByFile = indexImportNodesByFile(graph.nodes, index.fileByImportId);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));

  const resolved = new Set<string>();
  const callTargetByCallId = new Map<string, string>();
  const variableByInitializerCall = new Map<string, string>();
  const fileByVariableId = new Map<string, string>();
  const functionsByFileAndName = new Map<string, Map<string, string>>();
  for (const rel of graph.relationships) {
    if (rel.type === "CALL_RESOLVES_TO") {
      resolved.add(rel.from);
      callTargetByCallId.set(rel.from, rel.to);
    } else if (rel.type === "INITIALIZED_BY") {
      variableByInitializerCall.set(rel.to, rel.from);
    } else if (rel.type === "DEFINES_VARIABLE") {
      fileByVariableId.set(rel.to, rel.from);
    } else if (rel.type === "DEFINES_FUNCTION") {
      const name = nodeById.get(rel.to)?.properties.name;
      if (typeof name !== "string") continue;
      const byName = functionsByFileAndName.get(rel.from) ?? new Map<string, string>();
      if (!byName.has(name)) byName.set(name, rel.to);
      functionsByFileAndName.set(rel.from, byName);
    }
  }

  // The mixins each factory applies.
  const mixinsByFactory = new Map<string, Mixin[]>();
  for (const call of graph.nodes) {
    if (call.label !== "Call") continue;
    const factoryId = index.callerFunctionByCallId.get(call.id);
    const fileId = factoryId && index.fileByFunctionId.get(factoryId);
    const args = parseArgs(call.properties.args);
    if (!factoryId || !fileId || args.length < 2 || !isMixinCall(call, importsByFile.get(fileId) ?? [])) continue;
    const [target, source] = args as [string, string];
    const moduleFileId = importedFile(source, importsByFile.get(fileId) ?? [], index.resolvedFileByImportId);
    if (!isIdentifier(target) || !moduleFileId) continue;
    mixinsByFactory.set(factoryId, [...mixinsByFactory.get(factoryId) ?? [], { target, moduleFileId }]);
  }
  if (mixinsByFactory.size === 0) return;

  // Receivers that hold a factory's object: the target name inside the
  // factory and the functions nested in it, and file-level variables
  // initialized by calling the factory.
  const nestedFactory = (functionId: string): string | null => {
    const fn = nodeById.get(functionId);
    const fileId = index.fileByFunctionId.get(functionId);
    for (const factoryId of mixinsByFactory.keys()) {
      const factory = nodeById.get(factoryId);
      if (factoryId === functionId) return factoryId;
      if (!fn || !factory || index.fileByFunctionId.get(factoryId) !== fileId) continue;
      const [line, endLine] = [Number(fn.properties.line), Number(fn.properties.endLine ?? fn.properties.line)];
      if (line >= Number(factory.properties.line) && endLine <= Number(factory.properties.endLine ?? factory.properties.line)) return factoryId;
    }
    return null;
  };
  const factoryByFileAndVariable = new Map<string, Map<string, string>>();
  for (const [callId, variableId] of variableByInitializerCall) {
    const factoryId = callTargetByCallId.get(callId);
    const fileId = fileByVariableId.get(variableId);
    const name = nodeById.get(variableId)?.properties.name;
    if (!factoryId || !mixinsByFactory.has(factoryId) || !fileId || typeof name !== "string") continue;
    const byName = factoryByFileAndVariable.get(fileId) ?? new Map<string, string>();
    byName.set(name, factoryId);
    factoryByFileAndVariable.set(fileId, byName);
  }

  for (const call of graph.nodes) {
    if (call.label !== "Call" || resolved.has(call.id)) continue;
    const receiver = call.properties.receiver;
    const callee = call.properties.callee;
    if (typeof receiver !== "string" || typeof callee !== "string" || !isIdentifier(receiver)) continue;
    const callerId = index.callerFunctionByCallId.get(call.id);
    const callerFileId = callerId ? index.fileByFunctionId.get(callerId) : index.callerFileByModuleCallId.get(call.id);
    if (!callerFileId) continue;
    if (callerId && parameterNames(nodeById.get(callerId)?.properties.parameters).has(receiver)) continue;

    const enclosing = callerId ? nestedFactory(callerId) : null;
    const mixins = enclosing && mixinsByFactory.get(enclosing)!.some((mixin) => mixin.target === receiver)
      ? mixinsByFactory.get(enclosing)!.filter((mixin) => mixin.target === receiver)
      : mixinsByFactory.get(factoryByFileAndVariable.get(callerFileId)?.get(receiver) ?? "") ?? [];
    const methodId = mixins.map((mixin) => functionsByFileAndName.get(mixin.moduleFileId)?.get(callee)).find(Boolean);
    if (!methodId) continue;
    graph.addRelationship({ from: call.id, to: methodId, type: "CALL_RESOLVES_TO", properties: {} });
  }
}

function isMixinCall(call: GraphNode, imports: GraphNode[]): boolean {
  if (call.properties.expression === "Object.assign") return true;
  const callee = call.properties.callee;
  if (call.properties.receiver !== null || typeof callee !== "string") return false;
  return imports.some((importNode) =>
    MIXIN_PACKAGES.has(String(importNode.properties.source))
    && parseBindings(importNode).some((binding) => binding.kind === "default" && binding.local === callee));
}

// The scanned file a default (or `require`) binding of the file comes from.
function importedFile(local: string, imports: GraphNode[], resolvedFileByImportId: Map<string, string>): string | null {
  for (const importNode of imports) {
    if (!parseBindings(importNode).some((binding) => binding.kind === "default" && binding.local === local)) continue;
    const fileId = resolvedFileByImportId.get(importNode.id);
    if (fileId) return fileId;
  }
  return null;
}

function parseBindings(importNode: GraphNode): Array<{ local?: unknown; kind?: unknown }> {
  return parseJsonArray(importNode.properties.bindings) as Array<{ local?: unknown; kind?: unknown }>;
}

function parseArgs(raw: unknown): unknown[] {
  return parseJsonArray(raw);
}

function parameterNames(raw: unknown): Set<string> {
  const parameters = parseJsonArray(raw) as Array<{ name?: unknown }>;
  return new Set(parameters.flatMap((parameter) => typeof parameter.name === "string" ? [parameter.name] : []));
}

function parseJsonArray(raw: unknown): unknown[] {
  if (typeof raw !== "string") return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z_$][\w$]*$/u.test(value);
}

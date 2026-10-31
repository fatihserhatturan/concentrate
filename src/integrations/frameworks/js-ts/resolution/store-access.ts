import type { GraphNode, GraphRelationship } from "../../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../../core/contracts/semantic-contributor.js";
import { resolveDeclaration } from "../../../../core/scan/resolution/call-targets.js";
import { createResolutionRelationshipIndex, indexImportNodesByFile } from "../../../../core/scan/resolution/indexes.js";
import type { StoreAccess } from "../pinia.js";

// READS_STORE / WRITES_STORE: a call to a store's hook (`useCartStore()`,
// declared in the file or imported, through barrels) links the function that
// makes it to the Store. Every such call reads the store; `members` lists the
// state and getters it reads. It writes the store when it assigns state,
// changes it through a mutating method, calls an action, `$patch` or
// `$reset`, or takes an action by destructuring; `members` lists those. An
// action call (`cart.add(item)`) also gets CALL_RESOLVES_TO to the action's
// Function. Calls at the top level of a module have no function and are
// left out.

const writeMethods = new Set(["$patch", "$reset"]);

export const storeAccessContributor: ISemanticContributor = {
  contribute(graph) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const storesByFileAndName = new Map<string, Map<string, string[]>>();
    const actionsByStore = new Map<string, Map<string, string>>();
    for (const rel of graph.relationships) {
      const target = nodesById.get(rel.to);
      if (rel.type === "DECLARES_STORE" && target) {
        const byName = storesByFileAndName.get(rel.from) ?? new Map<string, string[]>();
        const hook = String(target.properties.hook);
        byName.set(hook, [...byName.get(hook) ?? [], target.id]);
        storesByFileAndName.set(rel.from, byName);
      }
      if (rel.type === "STORE_ACTION" && target) {
        const actions = actionsByStore.get(rel.from) ?? new Map<string, string>();
        actions.set(String(target.properties.name), target.id);
        actionsByStore.set(rel.from, actions);
      }
    }
    if (storesByFileAndName.size === 0) return;

    const index = createResolutionRelationshipIndex(graph.relationships);
    const importNodesByFile = indexImportNodesByFile(graph.nodes, index.fileByImportId);
    const resolved = new Set(graph.relationships.filter((rel) => rel.type === "CALL_RESOLVES_TO").map((rel) => rel.from));
    // `fileId:line:column:callee` → Call, for action calls.
    const callsByPosition = new Map<string, string>();
    const fileOfCall = (callId: string) => {
      const caller = index.callerFunctionByCallId.get(callId);
      return caller ? index.fileByFunctionId.get(caller) : index.callerFileByModuleCallId.get(callId);
    };
    for (const node of graph.nodes) {
      if (node.label !== "Call") continue;
      const fileId = fileOfCall(node.id);
      if (fileId) callsByPosition.set(`${fileId}:${node.properties.line}:${node.properties.columnNumber}:${node.properties.callee}`, node.id);
    }

    const added: GraphRelationship[] = [];
    for (const call of graph.nodes) {
      if (call.label !== "Call" || typeof call.properties.storeAccess !== "string") continue;
      const functionId = index.callerFunctionByCallId.get(call.id);
      const fileId = functionId ? index.fileByFunctionId.get(functionId) : undefined;
      if (!functionId || !fileId) continue;
      const storeId = resolveDeclaration(String(call.properties.callee), fileId, storesByFileAndName, importNodesByFile, index.resolvedFileByImportId);
      const store = storeId ? nodesById.get(storeId) : undefined;
      if (!store) continue;

      const access = parseAccess(call.properties.storeAccess);
      const actions = actionsByStore.get(store.id) ?? new Map<string, string>();
      const actionNames = new Set(String(store.properties.actions ?? "").split(",").filter(Boolean));
      const reads = new Set(access.reads);
      const writes = new Set(access.writes);
      for (const name of access.destructured) (actionNames.has(name) ? writes : reads).add(name);
      for (const { name, line, column } of access.calls) {
        if (actionNames.has(name) || writeMethods.has(name)) writes.add(name);
        const actionId = actions.get(name);
        const callId = actionId ? callsByPosition.get(`${fileId}:${line}:${column}:${name}`) : undefined;
        if (actionId && callId && !resolved.has(callId)) added.push({ from: callId, to: actionId, type: "CALL_RESOLVES_TO", properties: {} });
      }
      const line = Number(call.properties.line);
      added.push({ from: functionId, to: store.id, type: "READS_STORE", properties: { line, members: [...reads].join(",") } });
      if (writes.size > 0) added.push({ from: functionId, to: store.id, type: "WRITES_STORE", properties: { line, members: [...writes].join(",") } });
    }
    for (const rel of added) graph.addRelationship(rel);
  },
};

function parseAccess(value: GraphNode["properties"][string]): StoreAccess {
  try {
    return JSON.parse(String(value)) as StoreAccess;
  } catch {
    return { reads: [], writes: [], calls: [], destructured: [] };
  }
}

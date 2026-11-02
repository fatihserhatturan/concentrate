import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import { defaultAndNamedImports } from "./http-clients.js";
import { memberUse, objectEntries, ownFunction, returnedValue, type StoreAccess } from "./pinia.js";
import { stateReads } from "./redux.js";
import { unwrap } from "./react-router.js";

// Zustand stores, in a file that imports `create` from `zustand` (also the
// default import of zustand 3, `createWithEqualityFn` from
// `zustand/traditional`, or `createStore` from `zustand` / `zustand/vanilla`):
// each top-level `const useBearStore = create((set, get) => ({ … }))` (also
// exported, the default export, the curried `create<State>()(…)`, and
// wrapped in middleware: `create(devtools(persist((set) => ({ … }), …)))`)
// is a Store (library `zustand`, kind `hook`, or `vanilla` for `createStore`)
// named by its variable, which is also its `hook`. Of the keys of the object
// the creator returns, functions are `actions` (each a Function owning its
// calls and a STORE_ACTION) and the rest `state`; `combine(state, creator)`
// takes `state` from its first argument. The creator, when it has a
// Function, is STORE_DEFINED_BY_FUNCTION.
//
// Store use goes through the `use…Store` hook calls Pinia records
// (`storeAccess`), and adds:
// - a selector: `useBearStore((state) => state.bears)`, `({ bears }) => bears`,
//   or `useShallow((state) => ({ … }))`, takes the members it selects (the
//   store-access contributor counts an action taken as a write) instead of
//   the uses of the hook's result;
// - `useBearStore.getState()` followed by a member read or call
//   (`useBearStore.getState().increase()`), and `useBearStore.setState(…)`,
//   a write of the keys it sets.

const storeHook = /^use\w*Store$/u;
const factories = new Map([
  ["zustand:create", "hook"],
  ["zustand:default", "hook"],
  ["zustand/traditional:createWithEqualityFn", "hook"],
  ["zustand:createStore", "vanilla"],
  ["zustand/vanilla:createStore", "vanilla"],
  ["zustand/vanilla:default", "vanilla"],
]);

export function applyZustandSemantics({ fileNodeId, rootNode, parsed, state }: JsTsParsedFile): void {
  recordZustandAccess(rootNode, parsed.nodes);

  const imported = defaultAndNamedImports(parsed.nodes, parsed.relationships, fileNodeId);
  const kinds = new Map([...imported].flatMap(([local, from]) => factories.has(from) ? [[local, factories.get(from)!]] : []));
  if (kinds.size === 0) return;
  const combine = new Set([...imported].filter(([, from]) => from === "zustand/middleware:combine").map(([local]) => local));
  const functionIdByAst = new Map(state.functionAstPairs.map((pair) => [pair.astNode.id, pair.functionNodeId]));

  for (const statement of rootNode.namedChildren) {
    if (!statement) continue;
    const declaration = statement.type === "export_statement" ? statement.childForFieldName("declaration") : statement;
    const targets: Array<{ hook: string; call: SyntaxNode }> = [];
    if (declaration?.type === "lexical_declaration" || declaration?.type === "variable_declaration") {
      for (const declarator of declaration.namedChildren) {
        const name = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
        const value = unwrap(declarator?.childForFieldName("value") ?? null);
        if (name?.type === "identifier" && value?.type === "call_expression") targets.push({ hook: name.text, call: value });
      }
    } else if (statement.type === "export_statement" && statement.children.some((child) => child?.type === "default")) {
      const value = unwrap(statement.childForFieldName("value"));
      if (value?.type === "call_expression") targets.push({ hook: "default", call: value });
    }

    for (const { hook, call } of targets) {
      // `create(…)`, or the curried `create<State>()(…)`.
      let callee = call.childForFieldName("function");
      if (callee?.type === "call_expression") callee = callee.childForFieldName("function");
      const kind = callee?.type === "identifier" ? kinds.get(callee.text) : undefined;
      if (!kind) continue;
      const { creator, initialState } = unwrapMiddleware(call.childForFieldName("arguments")?.namedChildren[0] ?? null, combine);
      const returned = creator ? returnedValue(creator) : null;
      if (!creator || returned?.type !== "object") continue;

      const entries = objectEntries(returned);
      const actions = [...entries].filter(([, value]) => isFunction(value));
      const stateKeys = [
        ...(initialState?.type === "object" ? objectEntries(initialState).keys() : []),
        ...[...entries].filter(([, value]) => !isFunction(value)).map(([key]) => key),
      ];
      const line = call.startPosition.row + 1;
      const store: GraphNode = {
        id: `${fileNodeId}:store:${line}:${hook}`,
        label: "Store",
        properties: {
          name: hook,
          library: "zustand",
          kind,
          hook,
          state: joinNames(stateKeys),
          getters: null,
          actions: joinNames(actions.map(([name]) => name)),
          line,
          endLine: call.endPosition.row + 1,
        },
      };
      parsed.nodes.push(store);
      parsed.relationships.push({ from: fileNodeId, to: store.id, type: "DECLARES_STORE", properties: {} });
      const creatorId = functionIdByAst.get(creator.id);
      if (creatorId) parsed.relationships.push({ from: store.id, to: creatorId, type: "STORE_DEFINED_BY_FUNCTION", properties: {} });
      for (const [name, value] of actions) {
        // The action owns its calls, not the creator around it.
        if (creatorId && value && !functionIdByAst.has(value.id)) dropCalls(creatorId, value, parsed);
        const functionId = value && isFunction(value) ? ownFunction(fileNodeId, name, value, parsed, functionIdByAst) : null;
        if (functionId) parsed.relationships.push({ from: store.id, to: functionId, type: "STORE_ACTION", properties: {} });
      }
    }
  }
}

// Removes the calls `functionId` owns inside `node`.
function dropCalls(functionId: string, node: SyntaxNode, parsed: JsTsParsedFile["parsed"]): void {
  const start = node.startPosition;
  const end = node.endPosition;
  const inside = (line: number, column: number) => {
    const row = line - 1;
    return (row > start.row || (row === start.row && column >= start.column)) && (row < end.row || (row === end.row && column < end.column));
  };
  const nodesById = new Map(parsed.nodes.map((graphNode) => [graphNode.id, graphNode]));
  const dropped = new Set(parsed.relationships
    .filter((rel) => rel.type === "CALLS" && rel.from === functionId)
    .map((rel) => nodesById.get(rel.to))
    .filter((call): call is GraphNode => call !== undefined && inside(Number(call.properties.line), Number(call.properties.columnNumber)))
    .map((call) => call.id));
  if (dropped.size === 0) return;
  parsed.relationships.splice(0, parsed.relationships.length, ...parsed.relationships.filter((rel) => !dropped.has(rel.from) && !dropped.has(rel.to)));
  parsed.nodes.splice(0, parsed.nodes.length, ...parsed.nodes.filter((graphNode) => !dropped.has(graphNode.id)));
}

// The creator inside middleware: `devtools(persist((set) => ({ … }), opts))`;
// `combine(initialState, (set) => ({ … }))` also gives the initial state.
function unwrapMiddleware(node: SyntaxNode | null, combine: ReadonlySet<string>): { creator: SyntaxNode | null; initialState: SyntaxNode | null } {
  let current = unwrap(node);
  for (let depth = 0; current?.type === "call_expression" && depth < 8; depth++) {
    const args = current.childForFieldName("arguments")?.namedChildren.filter((arg): arg is SyntaxNode => arg !== null) ?? [];
    if (combine.has(current.childForFieldName("function")?.text ?? "")) {
      const creator = unwrap(args[1] ?? null);
      return { creator: isFunction(creator) ? creator : null, initialState: unwrap(args[0] ?? null) };
    }
    current = unwrap(args[0] ?? null);
  }
  return { creator: isFunction(current) ? current : null, initialState: null };
}

function isFunction(node: SyntaxNode | null | undefined): boolean {
  return node?.type === "arrow_function" || node?.type === "function_expression" || node?.type === "method_definition";
}

function joinNames(names: readonly string[]): string | null {
  return names.length > 0 ? names.join(",") : null;
}

// Selectors passed to `use…Store` hooks, `getState()` and `setState(…)`.
function recordZustandAccess(root: SyntaxNode, nodes: GraphNode[]): void {
  let calls: Map<string, GraphNode> | null = null;
  const callNode = (call: SyntaxNode, callee: string) => {
    if (!calls) {
      calls = new Map();
      for (const node of nodes) {
        if (node.label === "Call") calls.set(`${node.properties.line}:${node.properties.columnNumber}:${node.properties.callee}`, node);
      }
    }
    return calls.get(`${call.startPosition.row + 1}:${call.startPosition.column}:${callee}`);
  };
  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      const args = node.childForFieldName("arguments")?.namedChildren.filter((arg): arg is SyntaxNode => arg !== null) ?? [];
      if (callee?.type === "identifier" && storeHook.test(callee.text)) {
        const selector = selectorOf(args[0] ?? null);
        const call = selector ? callNode(node, callee.text) : undefined;
        if (call && selector) {
          const access: StoreAccess = { reads: [], writes: [], calls: [], destructured: [...new Set(stateReads(selector).map(([key]) => key))] };
          call.properties.storeAccess = JSON.stringify(access);
        }
      }
      const hook = callee?.type === "member_expression" ? callee.childForFieldName("object") : null;
      const member = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : undefined;
      if (hook?.type === "identifier" && storeHook.test(hook.text) && (member === "getState" || member === "setState")) {
        const call = callNode(node, member);
        if (call) {
          const access: StoreAccess & { hook: string } = { hook: hook.text, reads: [], writes: [], calls: [], destructured: [] };
          if (member === "setState") {
            access.calls.push({ name: "setState", line: node.startPosition.row + 1, column: node.startPosition.column });
            const values = unwrap(args[0] ?? null);
            const object = values?.type === "object" ? values : values && isFunction(values) ? returnedValue(values) : null;
            if (object?.type === "object") access.writes.push(...objectEntries(object).keys());
          } else if (node.parent?.type === "member_expression" && node.parent.childForFieldName("object")?.id === node.id) {
            memberUse(node.parent, access);
          }
          call.properties.storeAccess = JSON.stringify(access);
        }
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
}

// `(state) => state.bears`, or the one inside `useShallow(…)`.
function selectorOf(node: SyntaxNode | null): SyntaxNode | null {
  const value = unwrap(node);
  if (isFunction(value)) return value;
  if (value?.type === "call_expression" && value.childForFieldName("function")?.text === "useShallow") {
    const inner = unwrap(value.childForFieldName("arguments")?.namedChildren[0] ?? null);
    return isFunction(inner) ? inner : null;
  }
  return null;
}

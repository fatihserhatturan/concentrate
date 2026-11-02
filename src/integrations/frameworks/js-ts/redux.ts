import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import { objectEntries, ownFunction } from "./pinia.js";
import { routerImports, unwrap } from "./react-router.js";

// Redux Toolkit, in a file that imports from `@reduxjs/toolkit`:
// - Each top-level `const cartSlice = createSlice({ name: 'cart', initialState,
//   reducers })` (also exported) is a Store (library `redux`, kind `slice`)
//   named by its `name`, with the variable as `hook`. `state` lists the keys
//   of `initialState` (an object literal, or a constant of the file holding
//   one), `actions` the keys of `reducers` and `getters` those of `selectors`.
//   Each reducer that is a function (also `{ reducer, prepare }`) becomes a
//   Function owning its calls, and a STORE_ACTION. `reducer` lists the names
//   the file gives the slice's reducer: `default` for `export default
//   cartSlice.reducer`, `cartReducer` for `const cartReducer = cartSlice.reducer`.
// - Each top-level `const store = configureStore({ reducer: { cart: … } })`
//   is a Store (kind `store`) named by its variable; `state` lists the reducer
//   keys and `slices` maps each key to its reducer as written (`cartReducer`,
//   `cartSlice.reducer`). The reducer object may also be
//   `combineReducers({ … })`, inline or a constant of the file.
//
// Store use, in any file:
// - A selector passed to `useSelector` (or a `use…Selector` hook such as
//   `useAppSelector`) records on its Call (`reduxAccess`) the state it reads:
//   `(state) => state.cart.items` reads key `cart`, member `items`; a
//   destructured `({ cart }) => cart.items` reads the same. A selector passed
//   by name records `selector`.
// - A top-level function named `select…` whose first parameter it reads the
//   same way (`const selectItems = (state: RootState) => state.cart.items`)
//   records those reads on its Function (`storeSelects`).
// - A call inside `dispatch(…)` (also `store.dispatch(…)`) records
//   `dispatch`: `dispatch(addItem(x))`, `dispatch(cartSlice.actions.addItem(x))`.
// The store-access contributor maps state keys to slices through the
// `configureStore` reducers and action creators to the slices that declare
// them, and adds READS_STORE and WRITES_STORE.

export type ReduxAccess = {
  // [key, member] pairs a selector reads; member is null for the whole slice.
  reads?: Array<[string, string | null]>;
  selector?: string;
  dispatch?: boolean;
};

const selectorHook = /^use\w*Selector$/u;
const selectorName = /^select[A-Z0-9_$]/u;

export function applyReduxSemantics({ fileNodeId, rootNode, parsed, state }: JsTsParsedFile): void {
  recordReduxAccess(rootNode, parsed.nodes);
  recordSelectorFunctions(rootNode, parsed.nodes, state.functionAstPairs);

  const imported = routerImports(parsed.nodes, parsed.relationships, fileNodeId, /^@reduxjs\/toolkit$/u);
  const local = (name: string) => new Set([...imported].filter(([, from]) => from === name).map(([binding]) => binding));
  const createSlice = local("createSlice");
  const configureStore = local("configureStore");
  const combineReducers = local("combineReducers");
  if (createSlice.size === 0 && configureStore.size === 0) return;

  const declarations = topLevelDeclarations(rootNode);
  const functionIdByAst = new Map(state.functionAstPairs.map((pair) => [pair.astNode.id, pair.functionNodeId]));
  const slicesByHook = new Map<string, GraphNode>();
  for (const [name, { value }] of declarations) {
    const call = value?.type === "call_expression" ? value : null;
    const callee = call?.childForFieldName("function")?.text ?? "";
    const options = call?.childForFieldName("arguments")?.namedChildren[0];
    if (!call || options?.type !== "object") continue;
    const entries = objectEntries(options);
    const line = call.startPosition.row + 1;

    if (createSlice.has(callee)) {
      const sliceName = entries.get("name");
      if (sliceName?.type !== "string") continue;
      const id = sliceName.text.slice(1, -1);
      const reducers = entries.get("reducers");
      const selectors = entries.get("selectors");
      const store: GraphNode = {
        id: `${fileNodeId}:store:${line}:${id}`,
        label: "Store",
        properties: {
          name: id,
          library: "redux",
          kind: "slice",
          hook: name,
          state: joinNames(objectKeys(resolveLocal(entries.get("initialState") ?? null, declarations))),
          getters: joinNames(objectKeys(selectors ?? null)),
          actions: joinNames(objectKeys(reducers ?? null)),
          line,
          endLine: call.endPosition.row + 1,
        },
      };
      parsed.nodes.push(store);
      parsed.relationships.push({ from: fileNodeId, to: store.id, type: "DECLARES_STORE", properties: {} });
      slicesByHook.set(name, store);
      if (reducers?.type === "object") {
        for (const [action, reducer] of objectEntries(reducers)) {
          // `{ reducer(state, action) {…}, prepare(…) {…} }`
          const body = reducer?.type === "object" ? objectEntries(reducer).get("reducer") ?? null : reducer;
          const functionId = body ? ownFunction(fileNodeId, action, body, parsed, functionIdByAst) : null;
          if (functionId) parsed.relationships.push({ from: store.id, to: functionId, type: "STORE_ACTION", properties: {} });
        }
      }
    } else if (configureStore.has(callee)) {
      const reducer = resolveLocal(entries.get("reducer") ?? null, declarations);
      const reducers = reducer?.type === "call_expression" && combineReducers.has(reducer.childForFieldName("function")?.text ?? "")
        ? resolveLocal(reducer.childForFieldName("arguments")?.namedChildren[0] ?? null, declarations)
        : reducer;
      const slices = reducers?.type === "object"
        ? Object.fromEntries([...objectEntries(reducers)].map(([key, value]) => [key, value?.text ?? key]))
        : {};
      const store: GraphNode = {
        id: `${fileNodeId}:store:${line}:${name}`,
        label: "Store",
        properties: {
          name,
          library: "redux",
          kind: "store",
          hook: name,
          state: joinNames(Object.keys(slices)),
          getters: null,
          actions: null,
          line,
          endLine: call.endPosition.row + 1,
          slices: Object.keys(slices).length > 0 ? JSON.stringify(slices) : null,
        },
      };
      parsed.nodes.push(store);
      parsed.relationships.push({ from: fileNodeId, to: store.id, type: "DECLARES_STORE", properties: {} });
    }
  }

  // The names the file gives each slice's reducer.
  const reducerNames = new Map<GraphNode, string[]>();
  const sliceReducer = (value: SyntaxNode | null) => {
    const node = unwrap(value);
    if (node?.type !== "member_expression" || node.childForFieldName("property")?.text !== "reducer") return undefined;
    return slicesByHook.get(node.childForFieldName("object")?.text ?? "");
  };
  for (const [name, { value }] of declarations) {
    const slice = sliceReducer(value);
    if (slice) reducerNames.set(slice, [...reducerNames.get(slice) ?? [], name]);
  }
  for (const statement of rootNode.namedChildren) {
    if (statement?.type !== "export_statement" || !statement.children.some((child) => child?.type === "default")) continue;
    const slice = sliceReducer(statement.childForFieldName("value"));
    if (slice) reducerNames.set(slice, [...reducerNames.get(slice) ?? [], "default"]);
  }
  for (const [slice, names] of reducerNames) slice.properties.reducer = names.join(",");
}

type Declaration = { value: SyntaxNode | null };

// Top-level `const` / `let` / `var` declarations (exported or not), by name.
function topLevelDeclarations(root: SyntaxNode): Map<string, Declaration> {
  const declarations = new Map<string, Declaration>();
  for (const statement of root.namedChildren) {
    const declaration = statement?.type === "export_statement" ? statement.childForFieldName("declaration") : statement;
    if (declaration?.type !== "lexical_declaration" && declaration?.type !== "variable_declaration") continue;
    for (const declarator of declaration.namedChildren) {
      const name = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
      if (name?.type === "identifier") declarations.set(name.text, { value: unwrap(declarator!.childForFieldName("value")) });
    }
  }
  return declarations;
}

// An identifier (also a shorthand `{ initialState }`) naming a top-level
// constant of the file: its value.
function resolveLocal(node: SyntaxNode | null, declarations: ReadonlyMap<string, Declaration>): SyntaxNode | null {
  const value = unwrap(node);
  return value?.type === "identifier" || value?.type === "shorthand_property_identifier" ? declarations.get(value.text)?.value ?? null : value;
}

function objectKeys(node: SyntaxNode | null): string[] {
  return node?.type === "object" ? [...objectEntries(node).keys()] : [];
}

function joinNames(names: readonly string[]): string | null {
  return names.length > 0 ? names.join(",") : null;
}

function callsByPosition(nodes: readonly GraphNode[]): Map<string, GraphNode> {
  const calls = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.label === "Call") calls.set(`${node.properties.line}:${node.properties.columnNumber}:${node.properties.callee}`, node);
  }
  return calls;
}

function calleeName(call: SyntaxNode): string | null {
  const callee = call.childForFieldName("function");
  if (callee?.type === "identifier") return callee.text;
  return callee?.type === "member_expression" ? callee.childForFieldName("property")?.text ?? null : null;
}

// Selector hooks and dispatched calls.
function recordReduxAccess(root: SyntaxNode, nodes: GraphNode[]): void {
  let calls: Map<string, GraphNode> | null = null;
  const callNode = (call: SyntaxNode) => {
    calls ??= callsByPosition(nodes);
    return calls.get(`${call.startPosition.row + 1}:${call.startPosition.column}:${calleeName(call)}`);
  };
  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      const args = node.childForFieldName("arguments")?.namedChildren.filter((arg): arg is SyntaxNode => arg !== null) ?? [];
      const name = callee?.type === "identifier" ? callee.text : callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : undefined;
      if (callee?.type === "identifier" && selectorHook.test(callee.text) && args[0]) {
        const selector = unwrap(args[0]);
        const access: ReduxAccess | null = selector?.type === "identifier"
          ? { selector: selector.text }
          : selector && (selector.type === "arrow_function" || selector.type === "function_expression")
            ? { reads: stateReads(selector) }
            : null;
        const call = access && (access.selector || access.reads!.length > 0) ? callNode(node) : undefined;
        if (call) call.properties.reduxAccess = JSON.stringify(access);
      }
      if (name === "dispatch" && args[0]?.type === "call_expression") {
        const call = callNode(args[0]);
        if (call) call.properties.reduxAccess = JSON.stringify({ dispatch: true } satisfies ReduxAccess);
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
}

// `const selectItems = (state: RootState) => state.cart.items` and
// `function selectItems(state) { … }` at the top level.
function recordSelectorFunctions(root: SyntaxNode, nodes: GraphNode[], functionAstPairs: JsTsParsedFile["state"]["functionAstPairs"]): void {
  const functionIdByAst = new Map(functionAstPairs.map((pair) => [pair.astNode.id, pair.functionNodeId]));
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  for (const statement of root.namedChildren) {
    const declaration = statement?.type === "export_statement" ? statement.childForFieldName("declaration") : statement;
    const candidates: Array<[string, SyntaxNode]> = [];
    if (declaration?.type === "function_declaration") {
      const name = declaration.childForFieldName("name")?.text;
      if (name) candidates.push([name, declaration]);
    } else if (declaration?.type === "lexical_declaration" || declaration?.type === "variable_declaration") {
      for (const declarator of declaration.namedChildren) {
        const name = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
        const value = unwrap(declarator?.childForFieldName("value") ?? null);
        if (name?.type === "identifier" && (value?.type === "arrow_function" || value?.type === "function_expression")) candidates.push([name.text, value]);
      }
    }
    for (const [name, fn] of candidates) {
      if (!selectorName.test(name)) continue;
      const reads = stateReads(fn);
      const node = nodesById.get(functionIdByAst.get(fn.id) ?? "");
      if (node && reads.length > 0) node.properties.storeSelects = JSON.stringify(reads);
    }
  }
}

// The state a selector reads through its first parameter: `state.cart.items`
// → [cart, items], `state.cart` alone → [cart, null]; for `({ cart }) =>`,
// `cart.items` → [cart, items].
function stateReads(fn: SyntaxNode): Array<[string, string | null]> {
  const parameters = fn.childForFieldName("parameters");
  const first = fn.childForFieldName("parameter") ?? parameters?.namedChildren[0] ?? null;
  const pattern = first?.type === "required_parameter" || first?.type === "optional_parameter" ? first.childForFieldName("pattern") : first;
  const body = fn.childForFieldName("body");
  if (!pattern || !body) return [];
  const reads = new Map<string, [string, string | null]>();
  const add = (key: string, member: string | null) => reads.set(`${key}.${member ?? ""}`, [key, member]);
  // The key a member chain starts from: `state.cart` or a destructured `cart`.
  const keys = new Set<string>();
  let stateName: string | null = null;
  if (pattern.type === "identifier") stateName = pattern.text;
  else if (pattern.type === "object_pattern") {
    for (const entry of pattern.namedChildren) {
      if (entry?.type === "shorthand_property_identifier_pattern") keys.add(entry.text);
    }
  }
  if (!stateName && keys.size === 0) return [];
  const visit = (node: SyntaxNode) => {
    if (node.type === "member_expression") {
      const object = node.childForFieldName("object");
      const property = node.childForFieldName("property")?.text ?? null;
      if (object?.type === "identifier" && object.text === stateName && property) {
        const outer = node.parent?.type === "member_expression" && node.parent.childForFieldName("object")?.id === node.id
          ? node.parent.childForFieldName("property")?.text ?? null
          : null;
        add(property, outer);
        return;
      }
      if (object?.type === "identifier" && keys.has(object.text) && property) {
        add(object.text, property);
        return;
      }
    } else if (node.type === "identifier" && keys.has(node.text)) {
      add(node.text, null);
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(body);
  return [...reads.values()];
}

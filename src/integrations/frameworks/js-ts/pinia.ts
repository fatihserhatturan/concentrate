import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import { createCallNodes, createFunctionNode, type JsTsParsedFile } from "../../languages/js-ts/index.js";
import { routerImports, unwrap } from "./react-router.js";

// Pinia stores, in a file that imports `defineStore` from `pinia`: each
// top-level `const useCartStore = defineStore('cart', …)` (also exported,
// `defineStore({ id: 'cart', … })`, or the default export) is a Store
// (library `pinia`) named by its id, with the variable as `hook`.
// - Options stores (`{ state, getters, actions }`): `state` lists the keys of
//   the object the `state` function returns, `getters` and `actions` the keys
//   of those objects. Each getter and action that is a function becomes a
//   Function owning its calls, and every action is a STORE_ACTION.
// - Setup stores (`() => { …; return { … } }`): the setup function is
//   STORE_DEFINED_BY_FUNCTION; of the returned names, functions declared in it
//   are actions (STORE_ACTION), `computed(…)` values getters and the rest
//   state.
//
// Store use, in any file: a call to `use…Store()` records on its Call node
// (`storeAccess`) what the code around it does with the store: the members
// it reads, assigns (`store.count = 1`, `store.count++`, `store.items.push()`)
// or calls (`store.add(item)`, with their positions), through a variable
// (`const cart = useCartStore()`, its uses anywhere in the variable's
// scope), a destructuring (`const { add } = useCartStore()`), `storeToRefs`
// on such a variable, or directly (`useCartStore().add()`). The store-access
// contributor resolves the hook to its Store and turns this into READS_STORE
// and WRITES_STORE.

export type StoreAccess = {
  reads: string[];
  writes: string[];
  // `callee` is the local name of a destructured action (`const { add: put }`).
  calls: Array<{ name: string; line: number; column: number; callee?: string }>;
  destructured: string[];
};

const storeHook = /^use\w*Store$/u;
const mutatingMethods = new Set(["push", "pop", "shift", "unshift", "splice", "sort", "reverse", "fill", "set", "delete", "clear", "add"]);

export function applyPiniaSemantics({ fileNodeId, rootNode, parsed, state }: JsTsParsedFile): void {
  recordStoreAccess(rootNode, parsed.nodes);

  const imported = routerImports(parsed.nodes, parsed.relationships, fileNodeId, /^pinia$/u);
  const factories = new Set([...imported].filter(([, name]) => name === "defineStore").map(([local]) => local));
  if (factories.size === 0) return;

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
      if (!factories.has(call.childForFieldName("function")?.text ?? "")) continue;
      const args = call.childForFieldName("arguments")?.namedChildren.filter((arg): arg is SyntaxNode => arg !== null) ?? [];
      const options = args[0]?.type === "object" ? args[0] : args[1];
      const id = args[0]?.type === "string" ? args[0].text.slice(1, -1) : options?.type === "object" ? stringEntry(options, "id") : null;
      if (!id || !options) continue;

      const line = call.startPosition.row + 1;
      const store: GraphNode = {
        id: `${fileNodeId}:store:${line}:${id}`,
        label: "Store",
        properties: { name: id, library: "pinia", kind: null, hook, state: null, getters: null, actions: null, line, endLine: call.endPosition.row + 1 },
      };
      parsed.nodes.push(store);
      parsed.relationships.push({ from: fileNodeId, to: store.id, type: "DECLARES_STORE", properties: {} });

      if (options.type === "object") {
        store.properties.kind = "options";
        const entries = objectEntries(options);
        store.properties.state = joinNames(stateKeys(entries.get("state") ?? null));
        const getters = entries.get("getters");
        const actions = entries.get("actions");
        store.properties.getters = joinNames(getters?.type === "object" ? [...objectEntries(getters).keys()] : []);
        store.properties.actions = joinNames(actions?.type === "object" ? [...objectEntries(actions).keys()] : []);
        for (const [group, object] of [["getter", getters], ["action", actions]] as const) {
          if (object?.type !== "object") continue;
          for (const [name, value] of objectEntries(object)) {
            const functionId = value ? ownFunction(fileNodeId, name, value, parsed, functionIdByAst) : null;
            if (functionId && group === "action") parsed.relationships.push({ from: store.id, to: functionId, type: "STORE_ACTION", properties: {} });
          }
        }
      } else if (options.type === "arrow_function" || options.type === "function_expression") {
        store.properties.kind = "setup";
        const setupId = functionIdByAst.get(options.id);
        if (setupId) parsed.relationships.push({ from: store.id, to: setupId, type: "STORE_DEFINED_BY_FUNCTION", properties: {} });
        const members = setupMembers(options, functionIdByAst);
        store.properties.state = joinNames(members.state);
        store.properties.getters = joinNames(members.getters);
        store.properties.actions = joinNames(members.actions.map(({ name }) => name));
        for (const { functionId } of members.actions) {
          if (functionId) parsed.relationships.push({ from: store.id, to: functionId, type: "STORE_ACTION", properties: {} });
        }
      } else {
        store.properties.kind = "setup";
      }
    }
  }
}

// The Function of a getter or action: the one the file has for it, or one
// made here with its calls (methods of the options object have none).
function ownFunction(
  fileNodeId: string,
  name: string,
  value: SyntaxNode,
  parsed: JsTsParsedFile["parsed"],
  functionIdByAst: Map<number, string>,
): string | null {
  if (!["method_definition", "arrow_function", "function_expression"].includes(value.type)) return null;
  const known = functionIdByAst.get(value.id);
  if (known) return known;
  const node = createFunctionNode(fileNodeId, value, undefined, name);
  if (!node) return null;
  parsed.nodes.push(node);
  parsed.relationships.push({ from: fileNodeId, to: node.id, type: "DEFINES_FUNCTION", properties: {} });
  const body = value.childForFieldName("body");
  for (const call of body ? createCallNodes(node.id, body, new Set()) : []) {
    parsed.nodes.push(call);
    parsed.relationships.push({ from: node.id, to: call.id, type: "CALLS", properties: {} });
  }
  functionIdByAst.set(value.id, node.id);
  return node.id;
}

// `state: () => ({ items: [] })`, or a function whose body returns an object.
function stateKeys(state: SyntaxNode | null): string[] {
  if (!state || !["method_definition", "arrow_function", "function_expression"].includes(state.type)) return [];
  const returned = returnedValue(state);
  return returned?.type === "object" ? [...objectEntries(returned).keys()] : [];
}

function setupMembers(setup: SyntaxNode, functionIdByAst: Map<number, string>) {
  const result = { state: [] as string[], getters: [] as string[], actions: [] as Array<{ name: string; functionId: string | null }> };
  const body = setup.childForFieldName("body");
  const returned = returnedValue(setup);
  if (body?.type !== "statement_block" || returned?.type !== "object") return result;

  const declared = new Map<string, SyntaxNode>();
  for (const statement of body.namedChildren) {
    if (statement?.type === "function_declaration") {
      const name = statement.childForFieldName("name");
      if (name) declared.set(name.text, statement);
    }
    if (statement?.type === "lexical_declaration" || statement?.type === "variable_declaration") {
      for (const declarator of statement.namedChildren) {
        const name = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
        const value = unwrap(declarator?.childForFieldName("value") ?? null);
        if (name?.type === "identifier" && value) declared.set(name.text, value);
      }
    }
  }
  for (const [name, value] of objectEntries(returned)) {
    const local = declared.get(value?.type === "identifier" ? value.text : name);
    if (local && ["function_declaration", "arrow_function", "function_expression"].includes(local.type)) {
      result.actions.push({ name, functionId: functionIdByAst.get(local.id) ?? null });
    } else if (local?.type === "call_expression" && local.childForFieldName("function")?.text === "computed") {
      result.getters.push(name);
    } else {
      result.state.push(name);
    }
  }
  return result;
}

// What a function returns: an arrow's expression body, or the value of the
// last top-level `return` of its block.
function returnedValue(fn: SyntaxNode): SyntaxNode | null {
  const body = fn.childForFieldName("body");
  if (!body) return null;
  if (body.type !== "statement_block") return unwrap(body);
  const statement = body.namedChildren.filter((child) => child?.type === "return_statement").at(-1);
  return unwrap(statement?.namedChildren[0] ?? null);
}

// Key → value of an object literal (shorthand values are the identifier).
function objectEntries(object: SyntaxNode): Map<string, SyntaxNode | null> {
  const entries = new Map<string, SyntaxNode | null>();
  for (const entry of object.namedChildren) {
    if (entry?.type === "shorthand_property_identifier") entries.set(entry.text, entry);
    if (entry?.type === "pair") {
      const key = entry.childForFieldName("key");
      const name = key?.type === "string" ? key.text.slice(1, -1) : key?.text;
      if (name) entries.set(name, unwrap(entry.childForFieldName("value")));
    }
    if (entry?.type === "method_definition") {
      const name = entry.childForFieldName("name")?.text;
      if (name) entries.set(name, entry);
    }
  }
  return entries;
}

function stringEntry(object: SyntaxNode, key: string): string | null {
  const value = objectEntries(object).get(key);
  return value?.type === "string" ? value.text.slice(1, -1) : null;
}

function joinNames(names: readonly string[]): string | null {
  return names.length > 0 ? names.join(",") : null;
}

// Every `use…Store()` call: what the code does with the store it returns.
function recordStoreAccess(root: SyntaxNode, nodes: GraphNode[]): void {
  const callsByPosition = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.label === "Call") callsByPosition.set(`${node.properties.line}:${node.properties.columnNumber}:${node.properties.callee}`, node);
  }
  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      const call = callee?.type === "identifier" && storeHook.test(callee.text)
        ? callsByPosition.get(`${node.startPosition.row + 1}:${node.startPosition.column}:${callee.text}`)
        : undefined;
      if (call) call.properties.storeAccess = JSON.stringify(storeAccess(node));
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(root);
}

function storeAccess(hookCall: SyntaxNode): StoreAccess {
  const access: StoreAccess = { reads: [], writes: [], calls: [], destructured: [] };
  const parent = hookCall.parent;
  refsDestructuring(hookCall, access);
  if (parent?.type === "member_expression" && parent.childForFieldName("object")?.id === hookCall.id) {
    memberUse(parent, access);
  } else if (parent?.type === "variable_declarator" && parent.childForFieldName("value")?.id === hookCall.id) {
    const name = parent.childForFieldName("name");
    if (name?.type === "object_pattern") {
      access.destructured.push(...patternNames(name));
      // Calls of destructured members: `const { add } = useCartStore(); add(x)`.
      const scope = scopeOf(parent);
      for (const [member, local] of patternBindings(name)) {
        for (const use of identifierUses(scope, local.text, local.id)) {
          const call = use.parent;
          if (call?.type === "call_expression" && call.childForFieldName("function")?.id === use.id) {
            access.calls.push({ name: member, line: call.startPosition.row + 1, column: call.startPosition.column, ...(member !== local.text ? { callee: local.text } : {}) });
          }
        }
      }
    }
    if (name?.type === "identifier") {
      for (const use of identifierUses(scopeOf(parent), name.text, name.id)) {
        const usage = use.parent;
        if (usage?.type === "member_expression" && usage.childForFieldName("object")?.id === use.id) memberUse(usage, access);
        refsDestructuring(use, access);
      }
    }
  }
  for (const key of ["reads", "writes", "destructured"] as const) access[key] = [...new Set(access[key])];
  return access;
}

// `const { items } = storeToRefs(cart)` or `storeToRefs(useCartStore())`.
function refsDestructuring(store: SyntaxNode, access: StoreAccess): void {
  const refsCall = store.parent?.type === "arguments" ? store.parent.parent : null;
  if (refsCall?.type !== "call_expression" || refsCall.childForFieldName("function")?.text !== "storeToRefs") return;
  const declarator = refsCall.parent;
  const pattern = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
  if (pattern?.type === "object_pattern") access.reads.push(...patternNames(pattern));
}

// `store.member` in use: a call, an assignment or update (also of a nested
// property, or through a mutating method such as `push`), else a read.
function memberUse(member: SyntaxNode, access: StoreAccess): void {
  const name = member.childForFieldName("property")?.text;
  if (!name) return;
  const parent = member.parent;
  if (parent?.type === "call_expression" && parent.childForFieldName("function")?.id === member.id) {
    access.calls.push({ name, line: parent.startPosition.row + 1, column: parent.startPosition.column });
    return;
  }
  let top = member;
  while (top.parent && (top.parent.type === "member_expression" || top.parent.type === "subscript_expression") && top.parent.childForFieldName("object")?.id === top.id) {
    top = top.parent;
  }
  const outer = top.parent;
  const assigned = (outer?.type === "assignment_expression" || outer?.type === "augmented_assignment_expression") && outer.childForFieldName("left")?.id === top.id;
  const updated = outer?.type === "update_expression";
  const mutated = top !== member && top.type === "member_expression" && outer?.type === "call_expression"
    && outer.childForFieldName("function")?.id === top.id && mutatingMethods.has(top.childForFieldName("property")?.text ?? "");
  (assigned || updated || mutated ? access.writes : access.reads).push(name);
}

// The function body or program a declaration belongs to.
function scopeOf(node: SyntaxNode): SyntaxNode {
  let scope = node.parent;
  while (scope && scope.type !== "statement_block" && scope.type !== "program") scope = scope.parent;
  if (scope?.type === "statement_block" && scope.parent && !/function|method/u.test(scope.parent.type)) {
    // A block inside a function (an `if`): the variable is only visible there.
    return scope;
  }
  return scope ?? node;
}

function identifierUses(scope: SyntaxNode, name: string, declarationId: number): SyntaxNode[] {
  const uses: SyntaxNode[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.type === "identifier" && node.text === name && node.id !== declarationId) uses.push(node);
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(scope);
  return uses;
}

// `{ add, items: list }` → member → the identifier it is bound to.
function patternBindings(pattern: SyntaxNode): Array<[string, SyntaxNode]> {
  return pattern.namedChildren.flatMap((entry): Array<[string, SyntaxNode]> => {
    if (entry?.type === "shorthand_property_identifier_pattern") return [[entry.text, entry]];
    if (entry?.type === "pair_pattern") {
      const key = entry.childForFieldName("key");
      const value = entry.childForFieldName("value");
      return key && value?.type === "identifier" ? [[key.type === "string" ? key.text.slice(1, -1) : key.text, value]] : [];
    }
    return [];
  });
}

// `{ add, items: list, ...rest }` → the store members taken: add, items.
function patternNames(pattern: SyntaxNode): string[] {
  return pattern.namedChildren.flatMap((entry) => {
    if (entry?.type === "shorthand_property_identifier_pattern") return [entry.text];
    if (entry?.type === "pair_pattern") {
      const key = entry.childForFieldName("key");
      return key ? [key.type === "string" ? key.text.slice(1, -1) : key.text] : [];
    }
    if (entry?.type === "object_assignment_pattern") {
      const left = entry.childForFieldName("left");
      return left ? [left.text] : [];
    }
    return [];
  });
}

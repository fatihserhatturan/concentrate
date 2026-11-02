import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import { svelteExpressions } from "../../languages/html/parser.js";
import type { GraphNode, ImportBinding, ParsedSourceFile } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import { memberUse, objectEntries, returnedValue, type StoreAccess } from "./pinia.js";
import { routerImports, unwrap } from "./react-router.js";

// Svelte stores: each top-level `const count = writable(0)` (also `readable`,
// `derived`, imported from `svelte/store`, exported or not) is a Store
// (library `svelte`, kind the factory) named by the variable, which is also
// its `hook`; a start function or `derived` callback with a Function is
// STORE_DEFINED_BY_FUNCTION. A custom store, `const counter = createCounter()` where
// `createCounter` is a function of the file that makes a store and returns an
// object with `subscribe`, is kind `custom`: the factory is
// STORE_DEFINED_BY_FUNCTION and the other returned names are its `actions`
// (STORE_ACTION when the action has a Function). In a runes module
// (`.svelte.js` / `.svelte.ts`), a top-level `$state(…)` is kind `state`,
// with the keys of an object literal as `state`.
//
// Store use: a function's uses of a store binding are recorded on its
// Function node (`storeRefs`): `$count` (read; assigned or updated, a write),
// `count.set()` / `count.update()` (write), `count.subscribe()` and
// `get(count)` (read), members read, assigned or called (`counter.increment()`,
// `cart.items.push()`). The bindings are the stores the file declares and the
// imports used as stores (`$name`; `set` / `update` / `subscribe` and `get`
// in a component, a runes module or a file importing from `svelte`) or
// imported from a runes module. Uses at the top level of the instance
// `<script>` belong to its `<script>` Function, and so do the markup's
// (`{$count}`, `bind:value={$name}`, `onclick={counter.reset}`). The
// store-access contributor resolves the binding to its Store and adds
// READS_STORE and WRITES_STORE.

export type StoreRef = StoreAccess & { binding: string; line: number; read: boolean; write: boolean };

const factoryNames = new Set(["writable", "readable", "derived"]);
const runes = new Set(["$props", "$state", "$derived", "$effect", "$bindable", "$inspect", "$host"]);
const runesModule = /\.svelte\.[cm]?[jt]s$/u;
// An import of a runes module: `./cart.svelte.js`, or `./cart.svelte` for a
// named binding (a component is a default import).
const runesImport = /\.svelte(?:\.[cm]?[jt]s)?$/u;

export function applySvelteStoreSemantics({ fileNodeId, rootNode, parsed, state }: JsTsParsedFile): void {
  const functionIdByAst = new Map(state.functionAstPairs.map((pair) => [pair.astNode.id, pair.functionNodeId]));
  const storeImports = routerImports(parsed.nodes, parsed.relationships, fileNodeId, /^svelte\/store$/u);
  const factories = new Map([...storeImports].filter(([, name]) => factoryNames.has(name)));
  const getters = new Set([...storeImports].filter(([, name]) => name === "get").map(([local]) => local));
  const localStores = declareStores(fileNodeId, rootNode, parsed, factories, functionIdByAst);

  const svelte = fileLanguage(fileNodeId, parsed) === "svelte";
  // `x.set()` and `x.update()` make `x` a store only in Svelte code: a
  // component, a runes module or a file that imports from `svelte`.
  const svelteCode = svelte || runesModule.test(fileNodeId) || importsSvelte(fileNodeId, parsed);
  const candidates = new Map<string, boolean>();
  for (const name of localStores) candidates.set(name, true);
  for (const { local, source, kind } of importedBindings(fileNodeId, parsed)) {
    if (!candidates.has(local)) candidates.set(local, kind === "named" && runesImport.test(source));
  }
  if (candidates.size === 0) return;

  const uses = new Map<string, Array<{ node: SyntaxNode; dollar: boolean }>>();
  const visit = (node: SyntaxNode) => {
    if (node.type === "import_statement") return;
    if (node.type === "identifier") {
      const dollar = svelte && node.text.startsWith("$") && !runes.has(node.text) && candidates.has(node.text.slice(1));
      const name = dollar ? node.text.slice(1) : node.text;
      if ((dollar || candidates.has(name)) && !isDeclarationName(node)) {
        uses.set(name, [...uses.get(name) ?? [], { node, dollar }]);
        // An import used as a store makes it a store binding.
        if (dollar || (svelteCode && (storeMethodCall(node) || getterCall(node, getters)))) candidates.set(name, true);
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(rootNode);

  const scriptFunction = svelte ? instanceScriptFunction(parsed) : null;
  const refs = new Map<string, Map<string, StoreRef>>();
  for (const [binding, bindingUses] of uses) {
    if (!candidates.get(binding)) continue;
    for (const { node, dollar } of bindingUses) {
      const functionId = owningFunction(node, functionIdByAst)
        ?? (scriptFunction && withinLines(node, scriptFunction) ? scriptFunction.id : null);
      if (!functionId) continue;
      const byBinding = refs.get(functionId) ?? new Map<string, StoreRef>();
      refs.set(functionId, byBinding);
      const ref = byBinding.get(binding) ?? emptyRef(binding, node.startPosition.row + 1);
      byBinding.set(binding, ref);
      recordUse(node, dollar, getters, ref);
    }
  }
  for (const [functionId, byBinding] of refs) addStoreRefs(parsed, functionId, [...byBinding.values()]);
}

// The markup's store uses, on the instance `<script>` Function.
export function applySvelteTemplateStoreRefs(page: { fileNodeId: string; parsed: ParsedSourceFile; source: string }): void {
  const { fileNodeId, parsed, source } = page;
  if (fileLanguage(fileNodeId, parsed) !== "svelte") return;
  const scriptFunction = instanceScriptFunction(parsed);
  if (!scriptFunction) return;
  const declared = new Set(parsed.relationships.filter((rel) => rel.type === "DECLARES_STORE" && rel.from === fileNodeId).map((rel) => {
    return String(parsed.nodes.find((node) => node.id === rel.to)?.properties.hook);
  }));
  const bindings = new Set<string>(declared);
  for (const { local, source: importSource, kind } of importedBindings(fileNodeId, parsed)) {
    const used = new RegExp(`(?<![\\w$.])(?:\\$${escape(local)}\\b|${escape(local)}\\.(?:set|update|subscribe)\\s*\\()`, "u");
    if ((kind === "named" && runesImport.test(importSource)) || used.test(source)) bindings.add(local);
  }
  if (bindings.size === 0) return;

  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) if (source[index] === "\n") lineStarts.push(index + 1);
  const lineOf = (offset: number) => {
    let line = 0;
    while (line + 1 < lineStarts.length && lineStarts[line + 1]! <= offset) line += 1;
    return line + 1;
  };

  const refs = new Map<string, StoreRef>();
  const refFor = (binding: string, line: number) => {
    const ref = refs.get(binding) ?? emptyRef(binding, line);
    refs.set(binding, ref);
    return ref;
  };
  for (const { start, end } of svelteExpressions(source)) {
    const code = source.slice(start + 1, end);
    const line = lineOf(start);
    const attribute = /([\w:|.-]+)\s*=\s*$/u.exec(source.slice(Math.max(0, start - 80), start))?.[1] ?? "";
    const whole = code.trim();
    for (const match of code.matchAll(/(?<![\w$.])\$([A-Za-z_][\w]*)/gu)) {
      const binding = match[1]!;
      if (!bindings.has(binding)) continue;
      const ref = refFor(binding, line);
      const after = code.slice(match.index + match[0].length);
      const before = code.slice(0, match.index);
      const member = /^\s*\.\s*([A-Za-z_$][\w$]*)/u.exec(after)?.[1];
      if (attribute.startsWith("bind:") && whole === match[0]) {
        ref.write = true;
        ref.read = true;
      } else if (/^\s*=(?!=)/u.test(after)) {
        ref.write = true;
      } else if (/^\s*(?:\+\+|--|[-+*/%]=)/u.test(after) || /(?:\+\+|--)\s*$/u.test(before)) {
        ref.read = true;
        ref.write = true;
      } else {
        ref.read = true;
        if (member) ref.reads.push(member);
      }
    }
    for (const match of code.matchAll(/(?<![\w$.])([A-Za-z_][\w]*)\s*\.\s*([A-Za-z_$][\w$]*)/gu)) {
      const [text, binding, member] = match as unknown as [string, string, string];
      if (!bindings.has(binding)) continue;
      const ref = refFor(binding, line);
      const called = /^\s*\(/u.test(code.slice(match.index + text.length));
      const handler = /^on(?::|[a-z])/u.test(attribute) && whole === text;
      if (called || handler) ref.calls.push({ name: member, line, column: -1 });
      else ref.reads.push(member);
    }
  }
  if (refs.size > 0) addStoreRefs(parsed, scriptFunction.id, [...refs.values()]);
}

// Stores declared at the top level of the file; returns their variable names.
function declareStores(
  fileNodeId: string,
  rootNode: SyntaxNode,
  parsed: ParsedSourceFile,
  factories: ReadonlyMap<string, string>,
  functionIdByAst: ReadonlyMap<number, string>,
): string[] {
  const runes = runesModule.test(fileNodeId);
  if (factories.size === 0 && !runes) return [];
  const customFactories = factories.size > 0 ? customStoreFactories(rootNode, factories) : new Map<string, SyntaxNode>();
  const names: string[] = [];
  for (const statement of rootNode.namedChildren) {
    const declaration = statement?.type === "export_statement" ? statement.childForFieldName("declaration") : statement;
    if (declaration?.type !== "lexical_declaration" && declaration?.type !== "variable_declaration") continue;
    for (const declarator of declaration.namedChildren) {
      const name = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
      const call = unwrap(declarator?.childForFieldName("value") ?? null);
      if (name?.type !== "identifier" || call?.type !== "call_expression") continue;
      const callee = call.childForFieldName("function")?.text ?? "";
      const factory = factories.get(callee) ?? (runes && callee === "$state" ? "state" : customFactories.has(callee) ? "custom" : null);
      if (!factory) continue;

      const line = call.startPosition.row + 1;
      const store: GraphNode = {
        id: `${fileNodeId}:store:${line}:${name.text}`,
        label: "Store",
        properties: { name: name.text, library: "svelte", kind: factory, hook: name.text, state: null, getters: null, actions: null, line, endLine: call.endPosition.row + 1 },
      };
      parsed.nodes.push(store);
      parsed.relationships.push({ from: fileNodeId, to: store.id, type: "DECLARES_STORE", properties: {} });
      names.push(name.text);

      if (factory === "state") {
        const initial = unwrap(call.childForFieldName("arguments")?.namedChildren[0] ?? null);
        if (initial?.type === "object") store.properties.state = joinNames([...objectEntries(initial).keys()]);
      }
      const factoryFunction = factory === "custom" ? customFactories.get(callee) : undefined;
      if (factoryFunction) addCustomStore(store, factoryFunction, parsed, functionIdByAst);
      // The start function of `readable` / `writable`, the callback of `derived`.
      for (const argument of factoryNames.has(factory) ? call.childForFieldName("arguments")?.namedChildren ?? [] : []) {
        const functionId = argument ? functionIdByAst.get(argument.id) : undefined;
        if (functionId) parsed.relationships.push({ from: store.id, to: functionId, type: "STORE_DEFINED_BY_FUNCTION", properties: {} });
      }
    }
  }
  return names;
}

// Functions of the file that make a store and return an object with
// `subscribe`: `function createCounter() { const { subscribe, update } =
// writable(0); return { subscribe, increment: () => update((n) => n + 1) }; }`.
function customStoreFactories(rootNode: SyntaxNode, factories: ReadonlyMap<string, string>): Map<string, SyntaxNode> {
  const found = new Map<string, SyntaxNode>();
  for (const statement of rootNode.namedChildren) {
    const declaration = statement?.type === "export_statement" ? statement.childForFieldName("declaration") : statement;
    const candidates: Array<[string, SyntaxNode]> = [];
    if (declaration?.type === "function_declaration") {
      const name = declaration.childForFieldName("name");
      if (name) candidates.push([name.text, declaration]);
    } else if (declaration?.type === "lexical_declaration" || declaration?.type === "variable_declaration") {
      for (const declarator of declaration.namedChildren) {
        const name = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
        const value = unwrap(declarator?.childForFieldName("value") ?? null);
        if (name?.type === "identifier" && (value?.type === "arrow_function" || value?.type === "function_expression")) candidates.push([name.text, value]);
      }
    }
    for (const [name, fn] of candidates) {
      const returned = returnedValue(fn);
      if (returned?.type === "object" && objectEntries(returned).has("subscribe") && callsFactory(fn, factories)) found.set(name, fn);
    }
  }
  return found;
}

function callsFactory(node: SyntaxNode, factories: ReadonlyMap<string, string>): boolean {
  if (node.type === "call_expression" && factories.has(node.childForFieldName("function")?.text ?? "")) return true;
  return node.namedChildren.some((child) => child !== null && callsFactory(child, factories));
}

// The custom store's factory and its actions: the returned names other than
// `subscribe`, `set` and `update`.
function addCustomStore(store: GraphNode, factory: SyntaxNode, parsed: ParsedSourceFile, functionIdByAst: ReadonlyMap<number, string>): void {
  const factoryId = functionIdByAst.get(factory.id);
  if (factoryId) parsed.relationships.push({ from: store.id, to: factoryId, type: "STORE_DEFINED_BY_FUNCTION", properties: {} });
  const returned = returnedValue(factory);
  if (returned?.type !== "object") return;
  const body = factory.childForFieldName("body");
  const localFunctions = new Map<string, SyntaxNode>();
  for (const statement of body?.type === "statement_block" ? body.namedChildren : []) {
    if (statement?.type === "function_declaration") {
      const name = statement.childForFieldName("name");
      if (name) localFunctions.set(name.text, statement);
    }
    if (statement?.type === "lexical_declaration" || statement?.type === "variable_declaration") {
      for (const declarator of statement.namedChildren) {
        const name = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
        const value = unwrap(declarator?.childForFieldName("value") ?? null);
        if (name?.type === "identifier" && value) localFunctions.set(name.text, value);
      }
    }
  }
  const actions: string[] = [];
  for (const [name, value] of objectEntries(returned)) {
    if (name === "subscribe" || name === "set" || name === "update") continue;
    actions.push(name);
    const fn = value?.type === "identifier" || value?.type === "shorthand_property_identifier" ? localFunctions.get(value.text) : value;
    const functionId = fn ? functionIdByAst.get(fn.id) : undefined;
    if (functionId) parsed.relationships.push({ from: store.id, to: functionId, type: "STORE_ACTION", properties: {} });
  }
  store.properties.actions = joinNames(actions);
}

function recordUse(node: SyntaxNode, dollar: boolean, getters: ReadonlySet<string>, ref: StoreRef): void {
  const parent = node.parent;
  if (parent?.type === "member_expression" && parent.childForFieldName("object")?.id === node.id) {
    if (dollar) ref.read = true;
    memberUse(parent, ref);
    return;
  }
  if (getterCall(node, getters)) {
    ref.read = true;
    return;
  }
  if (dollar && (parent?.type === "assignment_expression") && parent.childForFieldName("left")?.id === node.id) {
    ref.write = true;
    return;
  }
  if (dollar && (parent?.type === "augmented_assignment_expression" || parent?.type === "update_expression")) {
    ref.read = true;
    ref.write = true;
    return;
  }
  ref.read = true;
}

// `count.set(…)`, `count.update(…)`, `count.subscribe(…)`.
function storeMethodCall(node: SyntaxNode): boolean {
  const member = node.parent;
  if (member?.type !== "member_expression" || member.childForFieldName("object")?.id !== node.id) return false;
  const call = member.parent;
  return call?.type === "call_expression" && call.childForFieldName("function")?.id === member.id
    && ["set", "update", "subscribe"].includes(member.childForFieldName("property")?.text ?? "");
}

// `get(count)` with `get` from `svelte/store`.
function getterCall(node: SyntaxNode, getters: ReadonlySet<string>): boolean {
  const call = node.parent?.type === "arguments" ? node.parent.parent : null;
  return call?.type === "call_expression" && getters.has(call.childForFieldName("function")?.text ?? "");
}

function isDeclarationName(node: SyntaxNode): boolean {
  const parent = node.parent;
  return (parent?.type === "variable_declarator" && parent.childForFieldName("name")?.id === node.id)
    || (parent?.type === "function_declaration" && parent.childForFieldName("name")?.id === node.id);
}

// The nearest enclosing function that has a node.
function owningFunction(node: SyntaxNode, functionIdByAst: ReadonlyMap<number, string>): string | null {
  for (let current = node.parent; current; current = current.parent) {
    const functionId = functionIdByAst.get(current.id);
    if (functionId) return functionId;
  }
  return null;
}

function instanceScriptFunction(parsed: ParsedSourceFile): GraphNode | null {
  return parsed.nodes.find((node) => node.label === "Function" && node.properties.kind === "script_instance") ?? null;
}

function withinLines(node: SyntaxNode, fn: GraphNode): boolean {
  const line = node.startPosition.row + 1;
  return line >= Number(fn.properties.line) && line <= Number(fn.properties.endLine);
}

// The named and default imports of the file, with their sources; not those
// of `svelte` itself or `.svelte` components.
function importedBindings(fileNodeId: string, parsed: ParsedSourceFile): Array<{ local: string; source: string; kind: string }> {
  const importIds = new Set(parsed.relationships.filter((rel) => rel.from === fileNodeId && rel.type === "IMPORTS").map((rel) => rel.to));
  const bindings: Array<{ local: string; source: string; kind: string }> = [];
  for (const node of parsed.nodes) {
    if (node.label !== "Import" || !importIds.has(node.id) || typeof node.properties.bindings !== "string") continue;
    const source = String(node.properties.source);
    if (source === "svelte" || source.startsWith("svelte/")) continue;
    for (const binding of JSON.parse(node.properties.bindings) as ImportBinding[]) {
      if (binding.kind === "named" || (binding.kind === "default" && !source.endsWith(".svelte"))) {
        bindings.push({ local: binding.local, source, kind: binding.kind });
      }
    }
  }
  return bindings;
}

function importsSvelte(fileNodeId: string, parsed: ParsedSourceFile): boolean {
  const importIds = new Set(parsed.relationships.filter((rel) => rel.from === fileNodeId && rel.type === "IMPORTS").map((rel) => rel.to));
  return parsed.nodes.some((node) => importIds.has(node.id) && /^svelte(?:\/|$)/u.test(String(node.properties.source)));
}

function emptyRef(binding: string, line: number): StoreRef {
  return { binding, line, read: false, write: false, reads: [], writes: [], calls: [], destructured: [] };
}

function addStoreRefs(parsed: ParsedSourceFile, functionId: string, refs: StoreRef[]): void {
  const fn = parsed.nodes.find((node) => node.id === functionId);
  if (!fn) return;
  const existing = typeof fn.properties.storeRefs === "string" ? JSON.parse(fn.properties.storeRefs) as StoreRef[] : [];
  for (const ref of refs) {
    ref.reads = [...new Set(ref.reads)];
    ref.writes = [...new Set(ref.writes)];
  }
  fn.properties.storeRefs = JSON.stringify([...existing, ...refs]);
}

function fileLanguage(fileNodeId: string, parsed: ParsedSourceFile): unknown {
  return parsed.nodes.find((node) => node.id === fileNodeId)?.properties.language;
}

function joinNames(names: readonly string[]): string | null {
  return names.length > 0 ? names.join(",") : null;
}

function escape(value: string): string {
  return value.replace(/[$]/gu, "\\$");
}

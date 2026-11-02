import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import { defaultAndNamedImports } from "./http-clients.js";
import { objectEntries } from "./pinia.js";
import { unwrap } from "./react-router.js";
import { addStoreRefs, emptyRef, owningFunction, type StoreRef } from "./svelte-stores.js";

// Jotai atoms, in a file that imports `atom` from `jotai` (or `jotai/vanilla`)
// or an `atomWith…` helper from `jotai/utils`: each top-level
// `const countAtom = atom(0)` (also exported) is a Store (library `jotai`)
// named by its variable, which is also its `hook`. `kind` is `primitive`
// for a value, `derived` for a read function, `writable` for a read function
// and a write function, `write-only` for `atom(null, write)`, or the helper's
// name (`atomWithStorage`). `state` lists the keys of an object literal
// value (the second argument of `atomWithStorage`). The read and write
// functions, when they have Functions, are STORE_DEFINED_BY_FUNCTION.
//
// Atom use is recorded on the Function it happens in (`storeRefs`, as for
// Svelte stores), with the atom's binding: `useAtomValue(a)` reads,
// `useSetAtom(a)` writes, `useAtom(a)` reads and, when its setter is taken
// (`const [v, setV] = useAtom(a)`), writes; in an atom's read or write
// function, `get(a)` reads and `set(a, …)` writes. The store-access
// contributor resolves the binding, through imports, to the atom's Store.

const sources = /^jotai(?:\/vanilla|\/utils|\/react|\/vanilla\/utils)?$/u;

export function applyJotaiSemantics({ fileNodeId, rootNode, parsed, state }: JsTsParsedFile): void {
  const imported = new Map([...defaultAndNamedImports(parsed.nodes, parsed.relationships, fileNodeId)]
    .flatMap(([local, from]) => {
      const separator = from.lastIndexOf(":");
      return sources.test(from.slice(0, separator)) ? [[local, from.slice(separator + 1)]] : [];
    }));
  if (imported.size === 0) return;
  const functionIdByAst = new Map(state.functionAstPairs.map((pair) => [pair.astNode.id, pair.functionNodeId]));
  const factories = new Set([...imported].filter(([, name]) => name === "atom" || /^atomWith[A-Z]\w*$/u.test(name)).map(([local]) => local));

  for (const statement of rootNode.namedChildren) {
    const declaration = statement?.type === "export_statement" ? statement.childForFieldName("declaration") : statement;
    if (declaration?.type !== "lexical_declaration" && declaration?.type !== "variable_declaration") continue;
    for (const declarator of declaration.namedChildren) {
      const name = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
      const call = unwrap(declarator?.childForFieldName("value") ?? null);
      const factory = call?.type === "call_expression" ? call.childForFieldName("function")?.text ?? "" : "";
      if (name?.type !== "identifier" || !call || !factories.has(factory)) continue;
      const helper = imported.get(factory)!;
      const args = call.childForFieldName("arguments")?.namedChildren.filter((arg): arg is SyntaxNode => arg !== null) ?? [];
      const read = isFunction(args[0]) ? args[0]! : null;
      const write = helper === "atom" && isFunction(args[1]) ? args[1]! : null;
      const kind = helper !== "atom" ? helper
        : read && write ? "writable"
          : read ? "derived"
            : write && unwrap(args[0] ?? null)?.type === "null" ? "write-only"
              : "primitive";
      const value = unwrap((helper === "atomWithStorage" ? args[1] : read ? null : args[0]) ?? null);
      const line = call.startPosition.row + 1;
      const store: GraphNode = {
        id: `${fileNodeId}:store:${line}:${name.text}`,
        label: "Store",
        properties: {
          name: name.text,
          library: "jotai",
          kind,
          hook: name.text,
          state: value?.type === "object" ? [...objectEntries(value).keys()].join(",") || null : null,
          getters: null,
          actions: null,
          line,
          endLine: call.endPosition.row + 1,
        },
      };
      parsed.nodes.push(store);
      parsed.relationships.push({ from: fileNodeId, to: store.id, type: "DECLARES_STORE", properties: {} });
      for (const fn of [read, write]) {
        const functionId = fn ? functionIdByAst.get(fn.id) : undefined;
        if (functionId) parsed.relationships.push({ from: store.id, to: functionId, type: "STORE_DEFINED_BY_FUNCTION", properties: {} });
      }
      if (read) recordGetSet(read, parsed, functionIdByAst);
      if (write) recordGetSet(write, parsed, functionIdByAst);
    }
  }

  const hooks = new Map([...imported].filter(([, name]) => ["useAtom", "useAtomValue", "useSetAtom"].includes(name)));
  if (hooks.size === 0) return;
  const refsByFunction = new Map<string, StoreRef[]>();
  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression") {
      const hook = hooks.get(node.childForFieldName("function")?.text ?? "");
      const atom = unwrap(node.childForFieldName("arguments")?.namedChildren[0] ?? null);
      const functionId = hook && atom?.type === "identifier" ? owningFunction(node, functionIdByAst) : null;
      if (hook && atom && functionId) {
        const ref = emptyRef(atom.text, node.startPosition.row + 1);
        ref.read = hook !== "useSetAtom";
        ref.write = hook === "useSetAtom" || (hook === "useAtom" && takesSetter(node));
        refsByFunction.set(functionId, [...refsByFunction.get(functionId) ?? [], ref]);
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(rootNode);
  for (const [functionId, refs] of refsByFunction) addStoreRefs(parsed, functionId, refs);
}

function isFunction(node: SyntaxNode | null | undefined): boolean {
  const value = unwrap(node ?? null);
  return value?.type === "arrow_function" || value?.type === "function_expression";
}

// `const [value, setValue] = useAtom(a)`.
function takesSetter(call: SyntaxNode): boolean {
  const declarator = call.parent;
  const pattern = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
  return pattern?.type === "array_pattern" && pattern.namedChildren.filter((element) => element !== null).length >= 2;
}

// `get(a)` and `set(a, …)` in an atom's read or write function, by the
// names of its first two parameters.
function recordGetSet(fn: SyntaxNode, parsed: JsTsParsedFile["parsed"], functionIdByAst: ReadonlyMap<number, string>): void {
  const functionId = functionIdByAst.get(fn.id);
  if (!functionId) return;
  const parameters = fn.childForFieldName("parameters")?.namedChildren.filter((parameter): parameter is SyntaxNode => parameter !== null) ?? [];
  const single = fn.childForFieldName("parameter");
  const names = (single ? [single] : parameters).map((parameter) => {
    const pattern = parameter.type === "required_parameter" || parameter.type === "optional_parameter" ? parameter.childForFieldName("pattern") : parameter;
    return pattern?.type === "identifier" ? pattern.text : null;
  });
  const [getName, setName] = names;
  const refs: StoreRef[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function")?.text;
      const atom = unwrap(node.childForFieldName("arguments")?.namedChildren[0] ?? null);
      if (atom?.type === "identifier" && callee && (callee === getName || callee === setName)) {
        const ref = emptyRef(atom.text, node.startPosition.row + 1);
        if (callee === getName) ref.read = true;
        else ref.write = true;
        refs.push(ref);
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  const body = fn.childForFieldName("body");
  if (body) visit(body);
  if (refs.length > 0) addStoreRefs(parsed, functionId, refs);
}

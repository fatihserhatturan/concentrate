import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import { createCallNodes, createFunctionNode, type JsTsParsedFile } from "../../languages/js-ts/index.js";
import { isHookCall, type PendingRender } from "./react.js";
import { createEntrypointNode } from "./entrypoint-graph.js";
import { indexFileFunctions, stripStringQuotes } from "./file-index.js";

// Vue single-file components: every `.vue` file is one Component (framework
// `vue`), named by its `name` option (`defineOptions({ name })`, `export
// default { name }`) or else by its file name in PascalCase. `kind` says how
// it is written: `script-setup` (`<script setup>`), `composition` (an options
// object with `setup()`), `options` (an options object, plain or in
// `defineComponent`) or `template` (no options object). `props` lists the
// declared props in order: `defineProps` with a type literal, an interface or
// type alias of the file, an object or an array, also under `withDefaults`;
// or the `props` option. The tags of the `<template>` that name components
// (`<UserCard>`, `<user-card>`) are recorded as `pendingRenders` with the
// props passed; the component-graph contributor links them to the components
// the file imports, through the `components` option's names.
//
// The component's code is a function: for `<script setup>` a Function named
// `<script setup>` spanning the block, which owns the block's top-level calls
// (they run once per component instance), or the `setup()` of the options
// object. `Component.hooks` lists the composables (`use*`) it calls, and the
// component-graph contributor links them with `USES_HOOK`. Listeners in the
// template (`@click="save"`, `v-on:submit.prevent="send()"`) on HTML elements
// are EntryPoints (kind `dom-event`, library `vue`) handled by the function
// of the file they name. The file's script is read by a JS/TS plugin and its
// template by a markup plugin, which builds the component.

type ScriptFacts = {
  name: string | null;
  props: string[] | null;
  hasOptions: boolean;
  hasSetup: boolean;
  // Registered name in PascalCase → the binding it registers (`components`).
  registered: Map<string, string>;
  // The `<script setup>` function or the options object's `setup()`.
  setupFunctionId: string | null;
};

const scriptFacts = new WeakMap<ParsedSourceFile, ScriptFacts>();

export function applyVueScriptSemantics({ fileNodeId, rootNode, parsed, state, scriptBlocks }: JsTsParsedFile): void {
  if (!isVueFile(fileNodeId, parsed)) return;
  const facts: ScriptFacts = { name: null, props: null, hasOptions: false, hasSetup: false, registered: new Map(), setupFunctionId: null };
  // Calls inside functions that have a node of their own stay theirs.
  const functionRanges = state.functionAstPairs.map((pair) => [pair.astNode.startIndex, pair.astNode.endIndex] as const);
  const ownedElsewhere = (call: GraphNode, statement: SyntaxNode) => {
    const index = startIndexOf(call, statement);
    return index !== null && functionRanges.some(([start, end]) => start <= index && index < end);
  };
  const options = defaultExportOptions(rootNode);
  if (options) {
    facts.hasOptions = true;
    for (const pair of options.namedChildren) {
      const key = propertyKey(pair);
      if (key === "setup" && pair) {
        facts.hasSetup = true;
        facts.setupFunctionId = optionsSetupFunction(fileNodeId, pair, parsed, state.functionAstPairs, ownedElsewhere);
      }
      if (pair?.type !== "pair") continue;
      const value = pair.childForFieldName("value");
      if (key === "name" && value?.type === "string") facts.name = stripStringQuotes(value.text);
      else if (key === "props" && value) facts.props = runtimeProps(value);
      else if (key === "components" && value?.type === "object") facts.registered = registeredComponents(value);
    }
  }
  for (const call of macroCalls(rootNode)) {
    const callee = call.childForFieldName("function")?.text;
    const argument = call.childForFieldName("arguments")?.namedChildren[0] ?? null;
    if (callee === "defineProps") {
      const typeArgument = call.childForFieldName("type_arguments")?.namedChildren[0] ?? null;
      facts.props = typeArgument ? typeProps(typeArgument, rootNode) : argument ? runtimeProps(argument) : [];
    } else if (callee === "defineOptions" && argument?.type === "object") {
      for (const pair of argument.namedChildren) {
        const value = pair?.type === "pair" ? pair.childForFieldName("value") : null;
        if (propertyKey(pair) === "name" && value?.type === "string") facts.name = stripStringQuotes(value.text);
      }
    }
  }
  const setupBlock = scriptBlocks.find((block) => block.attributes.includes("setup"));
  if (setupBlock) facts.setupFunctionId = scriptSetupFunction(fileNodeId, rootNode, parsed, setupBlock, ownedElsewhere);
  scriptFacts.set(parsed, facts);
}

// A Function for the `<script setup>` block that owns its top-level calls:
// module-level calls move to it, initializer calls (`const n = ref(0)`) are
// also its calls, and calls without a node of their own (in destructuring,
// arguments or anonymous callbacks) are added.
function scriptSetupFunction(
  fileNodeId: string,
  program: SyntaxNode,
  parsed: ParsedSourceFile,
  block: { start: number; end: number; line: number; endLine: number },
  ownedElsewhere: (call: GraphNode, statement: SyntaxNode) => boolean,
): string {
  const setup: GraphNode = {
    id: `${fileNodeId}:function:${block.line}:<script setup>`,
    label: "Function",
    properties: {
      name: "<script setup>",
      kind: "script_setup",
      methodKind: null,
      line: block.line,
      endLine: block.endLine,
      className: null,
      isExported: false,
      isAsync: false,
      isAbstract: false,
      visibility: "public",
      parameters: "[]",
      returnType: null,
    },
  };
  parsed.nodes.push(setup);
  parsed.relationships.push({ from: fileNodeId, to: setup.id, type: "DEFINES_FUNCTION", properties: {} });

  const fileCalls = new Map<string, GraphNode>();
  for (const node of parsed.nodes) {
    if (node.label === "Call" && (node.id.startsWith(`${fileNodeId}:modulecall:`) || node.id.startsWith(`${fileNodeId}:initializercall:`))) {
      fileCalls.set(`${node.properties.line}:${node.properties.columnNumber}`, node);
    }
  }
  const moved = new Set<string>();
  for (const statement of program.namedChildren) {
    if (!statement || statement.startIndex < block.start || statement.endIndex > block.end) continue;
    const code = statementCode(statement);
    if (!code) continue;
    for (const call of createCallNodes(setup.id, code, new Set())) {
      if (ownedElsewhere(call, code)) continue;
      const existing = fileCalls.get(`${call.properties.line}:${call.properties.columnNumber}`);
      if (existing?.id.includes(":modulecall:")) moved.add(existing.id);
      if (!existing) parsed.nodes.push(call);
      parsed.relationships.push({ from: setup.id, to: (existing ?? call).id, type: "CALLS", properties: {} });
    }
  }
  removeRelationships(parsed.relationships, (rel) => rel.type === "MODULE_CALLS" && rel.from === fileNodeId && moved.has(rel.to));
  return setup.id;
}

// The options object's `setup()`: the Function the file already has for it
// (`export default { setup() {} }`), or one made here with its calls
// (`defineComponent({ setup() {} })`, whose argument has no functions).
function optionsSetupFunction(
  fileNodeId: string,
  member: SyntaxNode,
  parsed: ParsedSourceFile,
  functionAstPairs: ReadonlyArray<{ functionNodeId: string; astNode: SyntaxNode }>,
  ownedElsewhere: (call: GraphNode, statement: SyntaxNode) => boolean,
): string | null {
  const fn = member.type === "pair" ? member.childForFieldName("value") : member;
  if (!fn || !["method_definition", "arrow_function", "function_expression", "function"].includes(fn.type)) return null;
  const known = functionAstPairs.find((pair) => pair.astNode.id === fn.id);
  if (known) return known.functionNodeId;
  const node = createFunctionNode(fileNodeId, fn, undefined, "setup");
  if (!node) return null;
  parsed.nodes.push(node);
  parsed.relationships.push({ from: fileNodeId, to: node.id, type: "DEFINES_FUNCTION", properties: {} });
  const body = fn.childForFieldName("body");
  for (const call of body ? createCallNodes(node.id, body, new Set()) : []) {
    if (ownedElsewhere(call, body!)) continue;
    parsed.nodes.push(call);
    parsed.relationships.push({ from: node.id, to: call.id, type: "CALLS", properties: {} });
  }
  return node.id;
}

// The code of a top-level statement that runs: expressions and variable
// declarations (also exported); imports and declared functions, classes and
// types do not.
function statementCode(statement: SyntaxNode): SyntaxNode | null {
  if (statement.type === "export_statement") {
    const declaration = statement.childForFieldName("declaration");
    return declaration ? statementCode(declaration) : null;
  }
  return ["expression_statement", "lexical_declaration", "variable_declaration"].includes(statement.type) ? statement : null;
}

// The source offset of a call node created from `root`, found by its position.
function startIndexOf(call: GraphNode, root: SyntaxNode): number | null {
  const row = Number(call.properties.line) - 1;
  const column = Number(call.properties.columnNumber);
  return root.descendantForPosition({ row, column })?.startIndex ?? null;
}

function removeRelationships(relationships: GraphRelationship[], drop: (rel: GraphRelationship) => boolean): void {
  let kept = 0;
  for (const rel of relationships) {
    if (!drop(rel)) relationships[kept++] = rel;
  }
  relationships.length = kept;
}

export function applyVueTemplateSemantics(page: { fileNodeId: string; documentNode: SyntaxNode; parsed: ParsedSourceFile }): void {
  const { fileNodeId, documentNode, parsed } = page;
  if (!isVueFile(fileNodeId, parsed)) return;
  const facts = scriptFacts.get(parsed);
  const topLevel = documentNode.namedChildren.filter((child): child is SyntaxNode => child !== null);
  const scriptSetup = topLevel.some((child) => child.type === "script_element" && hasAttribute(child, "setup"));
  const template = topLevel.find((child) => child.type === "element" && tagName(child) === "template");
  const renders = template ? templateRenders(template, facts?.registered ?? new Map()) : [];
  const setupFunctionId = facts?.setupFunctionId ?? null;
  const hooks = setupFunctionId ? hookNames(setupFunctionId, parsed) : [];

  const fileNode = parsed.nodes.find((node) => node.id === fileNodeId);
  const relativePath = String(fileNode?.properties.relativePath ?? fileNodeId.slice(5));
  const name = facts?.name ?? pascalCase(path.basename(relativePath, ".vue"));
  const component: GraphNode = {
    id: `${fileNodeId}:component:1:${name}`,
    label: "Component",
    properties: {
      name,
      framework: "vue",
      kind: scriptSetup ? "script-setup" : facts?.hasSetup ? "composition" : facts?.hasOptions ? "options" : "template",
      line: 1,
      endLine: documentNode.endPosition.row + (documentNode.endPosition.column === 0 ? 0 : 1),
      isExported: true,
      props: facts?.props ? facts.props.join(",") : null,
      pendingRenders: renders.length > 0 ? JSON.stringify(renders) : null,
      hooks: hooks.length > 0 ? hooks.join(",") : null,
    },
  };
  parsed.nodes.push(component);
  parsed.relationships.push({ from: fileNodeId, to: component.id, type: "DECLARES_COMPONENT", properties: {} });
  if (setupFunctionId) {
    parsed.relationships.push({ from: component.id, to: setupFunctionId, type: "COMPONENT_DEFINED_BY_FUNCTION", properties: {} });
  }
  if (template) addTemplateListeners(fileNodeId, template, parsed);
}

// The composables (and other `use*` calls) the component's function makes.
function hookNames(functionId: string, parsed: ParsedSourceFile): string[] {
  const calls = new Map(parsed.nodes.filter((node) => node.label === "Call" && isHookCall(node)).map((node) => [node.id, String(node.properties.callee)]));
  const names = new Set<string>();
  for (const rel of parsed.relationships) {
    const callee = rel.type === "CALLS" && rel.from === functionId ? calls.get(rel.to) : undefined;
    if (callee) names.add(callee);
  }
  return [...names].sort();
}

// `@click="save"`, `@submit.prevent="send($event)"`, `v-on:keyup.enter="next"`
// on HTML elements. Listeners on components are component events, not DOM
// events; dynamic event names (`@[name]`) and inline code (`@click="n++"`)
// name no handler but are still listeners.
function addTemplateListeners(fileNodeId: string, template: SyntaxNode, parsed: ParsedSourceFile): void {
  const functionsByName = indexFileFunctions(fileNodeId, parsed.nodes, parsed.relationships);
  const visit = (node: SyntaxNode) => {
    if (node.type === "start_tag" || node.type === "self_closing_tag") {
      const tag = node.namedChildren.find((child) => child?.type === "tag_name")?.text ?? "";
      if (/^[a-z][a-z0-9]*$/u.test(tag) && !nonElementTags.has(tag)) {
        for (const attribute of node.namedChildren) {
          if (attribute?.type === "attribute") addListener(fileNodeId, tag, attribute, functionsByName, parsed);
        }
      }
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  for (const child of template.namedChildren) {
    if (child && child.type !== "start_tag" && child.type !== "end_tag") visit(child);
  }
}

const nonElementTags = new Set(["component", "slot", "template"]);

function addListener(
  fileNodeId: string,
  tag: string,
  attribute: SyntaxNode,
  functionsByName: ReadonlyMap<string, string>,
  parsed: ParsedSourceFile,
): void {
  const name = attribute.namedChildren.find((child) => child?.type === "attribute_name")?.text ?? "";
  const event = /^(?:@|v-on:)([\w-]+)/u.exec(name)?.[1];
  if (!event) return;
  const valueNode = attribute.namedChildren.find((child) => child?.type === "attribute_value" || child?.type === "quoted_attribute_value");
  const value = valueNode?.type === "quoted_attribute_value"
    ? valueNode.namedChildren.find((child) => child?.type === "attribute_value")?.text ?? ""
    : valueNode?.text ?? "";
  // `save` or `save(…)`: the function the listener calls.
  const handlerName = /^\s*([A-Za-z_$][\w$]*)\s*(?:\(|$)/u.exec(value)?.[1] ?? null;
  const entrypoint = createEntrypointNode({
    fileNodeId,
    row: attribute.startPosition.row + 1,
    column: attribute.startPosition.column,
    kind: "dom-event",
    trigger: event,
    receiverName: tag,
    library: "vue",
    handlerName,
  });
  parsed.nodes.push(entrypoint);
  parsed.relationships.push({ from: fileNodeId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} });
  const handlerId = handlerName ? functionsByName.get(handlerName) : undefined;
  if (handlerId) parsed.relationships.push({ from: entrypoint.id, to: handlerId, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
}

function isVueFile(fileNodeId: string, parsed: ParsedSourceFile): boolean {
  return parsed.nodes.find((node) => node.id === fileNodeId)?.properties.language === "vue";
}

// `export default { … }` or `export default defineComponent({ … })`, through
// `as` / `satisfies` and parentheses.
function defaultExportOptions(program: SyntaxNode): SyntaxNode | null {
  for (const statement of program.namedChildren) {
    if (statement?.type !== "export_statement" || !statement.children.some((child) => child?.type === "default")) continue;
    let value = unwrap(statement.childForFieldName("value") ?? statement.namedChildren.at(-1) ?? null);
    if (value?.type === "call_expression" && value.childForFieldName("function")?.text === "defineComponent") {
      value = unwrap(value.childForFieldName("arguments")?.namedChildren[0] ?? null);
    }
    return value?.type === "object" ? value : null;
  }
  return null;
}

function unwrap(node: SyntaxNode | null): SyntaxNode | null {
  while (node && (node.type === "parenthesized_expression" || node.type === "as_expression" || node.type === "satisfies_expression")) {
    node = node.namedChildren[0] ?? null;
  }
  return node;
}

// Compiler macros of `<script setup>` at the top level of the script:
// `defineProps(…)`, `const props = defineProps(…)`, `withDefaults(defineProps(…), …)`.
function macroCalls(program: SyntaxNode): SyntaxNode[] {
  const calls: SyntaxNode[] = [];
  const add = (node: SyntaxNode | null) => {
    node = unwrap(node);
    if (node?.type !== "call_expression") return;
    const callee = node.childForFieldName("function")?.text;
    if (callee === "withDefaults") add(node.childForFieldName("arguments")?.namedChildren[0] ?? null);
    else if (callee === "defineProps" || callee === "defineOptions") calls.push(node);
  };
  for (const statement of program.namedChildren) {
    if (statement?.type === "expression_statement") add(statement.namedChildren[0] ?? null);
    if (statement?.type !== "lexical_declaration" && statement?.type !== "variable_declaration") continue;
    for (const declarator of statement.namedChildren) {
      if (declarator?.type === "variable_declarator") add(declarator.childForFieldName("value"));
    }
  }
  return calls;
}

// `['id', 'label']` or `{ id: String, label: { type: String } }`.
function runtimeProps(value: SyntaxNode): string[] {
  value = unwrap(value) ?? value;
  if (value.type === "array") {
    return value.namedChildren.flatMap((item) => (item?.type === "string" ? [stripStringQuotes(item.text)] : []));
  }
  if (value.type === "object") return value.namedChildren.flatMap((pair) => propertyKey(pair) ?? []);
  return [];
}

// `defineProps<{ id: string }>()` or `defineProps<Props>()` with `interface
// Props` / `type Props = { … }` in the file. Other types (imported ones,
// intersections) give no props.
function typeProps(type: SyntaxNode, program: SyntaxNode): string[] {
  if (type.type === "object_type") return typeMembers(type);
  if (type.type !== "type_identifier") return [];
  for (const child of program.namedChildren) {
    const statement = child?.type === "export_statement"
      ? child.namedChildren.find((declaration) => declaration?.type.endsWith("_declaration")) ?? null
      : child;
    if (statement?.childForFieldName("name")?.text !== type.text) continue;
    if (statement.type === "interface_declaration") {
      const body = statement.childForFieldName("body");
      return body ? typeMembers(body) : [];
    }
    if (statement.type === "type_alias_declaration") {
      const value = statement.childForFieldName("value");
      return value?.type === "object_type" ? typeMembers(value) : [];
    }
  }
  return [];
}

function typeMembers(body: SyntaxNode): string[] {
  return body.namedChildren.flatMap((member) => {
    if (member?.type !== "property_signature") return [];
    const name = member.childForFieldName("name");
    return name ? [stripStringQuotes(name.text)] : [];
  });
}

// `components: { UserCard, Item: ListItem, 'user-list': UserList }`.
function registeredComponents(object: SyntaxNode): Map<string, string> {
  const registered = new Map<string, string>();
  for (const pair of object.namedChildren) {
    if (pair?.type === "shorthand_property_identifier") registered.set(pascalCase(pair.text), pair.text);
    if (pair?.type !== "pair") continue;
    const key = propertyKey(pair);
    const value = pair.childForFieldName("value");
    if (key && value?.type === "identifier") registered.set(pascalCase(key), value.text);
  }
  return registered;
}

function propertyKey(pair: SyntaxNode | null): string | null {
  if (pair?.type === "shorthand_property_identifier") return pair.text;
  if (pair?.type === "method_definition") return pair.childForFieldName("name")?.text ?? null;
  if (pair?.type !== "pair") return null;
  const key = pair.childForFieldName("key");
  if (key?.type === "property_identifier") return key.text;
  if (key?.type === "string") return stripStringQuotes(key.text);
  return null;
}

// Elements of the template whose tag names a component: PascalCase
// (`<UserCard>`, `<Form.Input>`) or kebab-case (`<user-card>`, read as
// `UserCard`). Lowercase tags without a hyphen are HTML elements (and
// `<component>`, `<slot>`, `<template>`).
function templateRenders(template: SyntaxNode, registered: ReadonlyMap<string, string>): PendingRender[] {
  const renders: PendingRender[] = [];
  const visit = (node: SyntaxNode) => {
    if (node.type === "start_tag" || node.type === "self_closing_tag") {
      const tag = node.namedChildren.find((child) => child?.type === "tag_name")?.text ?? "";
      const name = /^[A-Z]/u.test(tag) || /^[a-z][\w$]*\.[A-Z]/u.test(tag) ? tag : tag.includes("-") ? pascalCase(tag) : null;
      if (name) {
        renders.push({ name: registered.get(name) ?? name, props: passedProps(node), line: node.startPosition.row + 1 });
      }
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  for (const child of template.namedChildren) {
    if (child && child.type !== "start_tag" && child.type !== "end_tag") visit(child);
  }
  return renders;
}

// Attributes and bindings (`title`, `:user`, `v-bind:user`, `v-model` as
// `modelValue`, `v-model:title`); event listeners, slots and other
// directives are not props.
function passedProps(tag: SyntaxNode): string[] {
  const props: string[] = [];
  for (const attribute of tag.namedChildren) {
    if (attribute?.type !== "attribute") continue;
    const name = attribute.namedChildren.find((child) => child?.type === "attribute_name")?.text ?? "";
    let prop: string | null = name;
    if (name === "v-model") prop = "modelValue";
    else if (name.startsWith("v-model:")) prop = name.slice(8);
    else if (name.startsWith("v-bind:")) prop = name.slice(7);
    else if (name.startsWith(":")) prop = name.slice(1);
    else if (name.startsWith("@") || name.startsWith("#") || name.startsWith("v-")) prop = null;
    const key = prop?.replace(/\..*$/u, "");
    if (key && /^[\w$-]+$/u.test(key)) props.push(key);
  }
  return props;
}

function hasAttribute(element: SyntaxNode, name: string): boolean {
  const startTag = element.namedChildren.find((child) => child?.type === "start_tag");
  return startTag?.namedChildren.some((attribute) => (
    attribute?.type === "attribute" && attribute.namedChildren.find((child) => child?.type === "attribute_name")?.text.toLowerCase() === name
  )) ?? false;
}

function tagName(element: SyntaxNode): string | null {
  const startTag = element.namedChildren.find((child) => child?.type === "start_tag");
  return startTag?.namedChildren.find((child) => child?.type === "tag_name")?.text.toLowerCase() ?? null;
}

// `user-card` / `user_card` / `userCard` → `UserCard`.
function pascalCase(value: string): string {
  return value.split(/[-_.\s]+/u).filter(Boolean).map((part) => part[0]!.toUpperCase() + part.slice(1)).join("");
}

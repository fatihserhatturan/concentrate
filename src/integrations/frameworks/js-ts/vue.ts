import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, ParsedSourceFile } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import type { PendingRender } from "./react.js";
import { stripStringQuotes } from "./file-index.js";

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
// the file imports, through the `components` option's names. The file's
// script is read by a JS/TS plugin and its template by a markup plugin, which
// builds the component.

type ScriptFacts = {
  name: string | null;
  props: string[] | null;
  hasOptions: boolean;
  hasSetup: boolean;
  // Registered name in PascalCase → the binding it registers (`components`).
  registered: Map<string, string>;
};

const scriptFacts = new WeakMap<ParsedSourceFile, ScriptFacts>();

export function applyVueScriptSemantics({ fileNodeId, rootNode, parsed }: JsTsParsedFile): void {
  if (!isVueFile(fileNodeId, parsed)) return;
  const facts: ScriptFacts = { name: null, props: null, hasOptions: false, hasSetup: false, registered: new Map() };
  const options = defaultExportOptions(rootNode);
  if (options) {
    facts.hasOptions = true;
    for (const pair of options.namedChildren) {
      const key = propertyKey(pair);
      if (key === "setup") facts.hasSetup = true;
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
  scriptFacts.set(parsed, facts);
}

export function applyVueTemplateSemantics(page: { fileNodeId: string; documentNode: SyntaxNode; parsed: ParsedSourceFile }): void {
  const { fileNodeId, documentNode, parsed } = page;
  if (!isVueFile(fileNodeId, parsed)) return;
  const facts = scriptFacts.get(parsed);
  const topLevel = documentNode.namedChildren.filter((child): child is SyntaxNode => child !== null);
  const scriptSetup = topLevel.some((child) => child.type === "script_element" && hasAttribute(child, "setup"));
  const template = topLevel.find((child) => child.type === "element" && tagName(child) === "template");
  const renders = template ? templateRenders(template, facts?.registered ?? new Map()) : [];

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
    },
  };
  parsed.nodes.push(component);
  parsed.relationships.push({ from: fileNodeId, to: component.id, type: "DECLARES_COMPONENT", properties: {} });
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

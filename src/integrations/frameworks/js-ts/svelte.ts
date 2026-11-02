import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, ParsedSourceFile } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import type { PendingRender } from "./react.js";
import { createEntrypointNode } from "./entrypoint-graph.js";
import { indexFileFunctions } from "./file-index.js";
import { callsOwnedElsewhere, pascalCase, scriptBlockFunction } from "./vue.js";

// Svelte components: every `.svelte` file is one Component (framework
// `svelte`) named by its file name in PascalCase. `kind` says how it is
// written: `runes` (its script uses `$props`, `$state`, `$derived`, …),
// `legacy` (a script without runes) or `template` (no instance script).
// `props` lists the declared props in order: `export let` declarations, or
// the names destructured from `$props()`. The tags of the markup that name
// components (`<UserCard>`, `<Ui.Button>`, `<svelte:component this={View}>`)
// are recorded as `pendingRenders` with the props passed; the component-graph
// contributor links them to the components the file imports.
//
// The component's code is the instance `<script>` (not `<script module>` /
// `context="module"`): a Function named `<script>` spanning the block, which
// owns the block's top-level calls (they run once per component instance).
// Listeners on HTML elements (`onclick={save}`, `on:click|preventDefault={save}`,
// `onclick={() => save(item)}`) are EntryPoints (kind `dom-event`, library
// `svelte`) handled by the function of the file they name. The file's script
// is read by a JS/TS plugin and its markup by a markup plugin, which builds
// the component.

type ScriptFacts = {
  props: string[];
  runes: boolean;
  scriptFunctionId: string | null;
};

const scriptFacts = new WeakMap<ParsedSourceFile, ScriptFacts>();

const runePattern = /^\$(?:props|state|derived|effect|bindable|inspect|host)(?:\.\w+)?$/u;

export function applySvelteScriptSemantics({ fileNodeId, rootNode, parsed, state, scriptBlocks }: JsTsParsedFile): void {
  if (!isSvelteFile(fileNodeId, parsed)) return;
  const block = scriptBlocks.find((candidate) => !candidate.attributes.includes("module") && !candidate.attributes.includes("context"));
  if (!block) return;
  const statements = rootNode.namedChildren.filter((statement): statement is SyntaxNode => (
    statement !== null && statement.startIndex >= block.start && statement.endIndex <= block.end
  ));
  const facts: ScriptFacts = { props: [], runes: statements.some(usesRunes), scriptFunctionId: null };
  for (const statement of statements) facts.props.push(...declaredProps(statement));
  const ownedElsewhere = callsOwnedElsewhere(state.functionAstPairs);
  facts.scriptFunctionId = scriptBlockFunction(fileNodeId, rootNode, parsed, block, ownedElsewhere, "<script>", "script_instance");
  scriptFacts.set(parsed, facts);
}

// `export let id;`, `export let a = 1, b;` (not `export const` or `export
// function`, which are not props), or `let { id, label = '', ...rest } =
// $props()`.
function declaredProps(statement: SyntaxNode): string[] {
  if (statement.type === "export_statement") {
    const declaration = statement.childForFieldName("declaration");
    if (!declaration || !isLetDeclaration(declaration)) return [];
    return declarators(declaration).flatMap((declarator) => {
      const name = declarator.childForFieldName("name");
      return name?.type === "identifier" ? [name.text] : [];
    });
  }
  if (statement.type !== "lexical_declaration" && statement.type !== "variable_declaration") return [];
  return declarators(statement).flatMap((declarator) => {
    const value = declarator.childForFieldName("value");
    const pattern = declarator.childForFieldName("name");
    if (value?.type !== "call_expression" || value.childForFieldName("function")?.text !== "$props") return [];
    return pattern?.type === "object_pattern" ? patternKeys(pattern) : [];
  });
}

function isLetDeclaration(declaration: SyntaxNode): boolean {
  return (declaration.type === "lexical_declaration" && declaration.children[0]?.text === "let") || declaration.type === "variable_declaration";
}

function declarators(declaration: SyntaxNode): SyntaxNode[] {
  return declaration.namedChildren.filter((child): child is SyntaxNode => child?.type === "variable_declarator");
}

export function patternKeys(pattern: SyntaxNode): string[] {
  return pattern.namedChildren.flatMap((property) => {
    if (property?.type === "shorthand_property_identifier_pattern") return [property.text];
    if (property?.type === "object_assignment_pattern") {
      const left = property.childForFieldName("left");
      return left ? [left.text] : [];
    }
    if (property?.type === "pair_pattern") {
      const key = property.childForFieldName("key");
      return key?.type === "property_identifier" ? [key.text] : [];
    }
    return [];
  });
}

function usesRunes(node: SyntaxNode): boolean {
  if (node.type === "call_expression" && runePattern.test(node.childForFieldName("function")?.text ?? "")) return true;
  return node.namedChildren.some((child) => child !== null && usesRunes(child));
}

export function applySvelteMarkupSemantics(page: { fileNodeId: string; documentNode: SyntaxNode; parsed: ParsedSourceFile; source: string }): void {
  const { fileNodeId, documentNode, parsed, source } = page;
  if (!isSvelteFile(fileNodeId, parsed)) return;
  const facts = scriptFacts.get(parsed);
  const markup = documentNode.namedChildren.filter((child): child is SyntaxNode => (
    child !== null && child.type !== "script_element" && child.type !== "style_element"
  ));
  const renders: PendingRender[] = [];
  const functionsByName = indexFileFunctions(fileNodeId, parsed.nodes, parsed.relationships);
  const visit = (node: SyntaxNode) => {
    if (node.type === "start_tag" || node.type === "self_closing_tag") {
      const tag = /^<([\w$:-]+(?:\.[\w$]+)*)/u.exec(source.slice(node.startIndex, node.endIndex))?.[1] ?? "";
      const attributes = node.namedChildren.filter((child): child is SyntaxNode => child?.type === "attribute");
      const rendered = renderedName(tag, attributes, source);
      if (rendered) {
        const props = passedProps(attributes, source).filter((prop) => tag !== "svelte:component" || prop !== "this");
        renders.push({ name: rendered, props, line: node.startPosition.row + 1 });
      } else if (/^[a-z][a-z0-9]*$/u.test(tag)) {
        for (const attribute of attributes) addListener(fileNodeId, tag, attribute, source, functionsByName, parsed);
      }
    }
    for (const child of node.namedChildren) {
      if (child) visit(child);
    }
  };
  for (const node of markup) visit(node);

  const fileNode = parsed.nodes.find((node) => node.id === fileNodeId);
  const relativePath = String(fileNode?.properties.relativePath ?? fileNodeId.slice(5));
  const name = pascalCase(path.basename(relativePath, ".svelte").replace(/[^\w$.-]/gu, ""));
  const component: GraphNode = {
    id: `${fileNodeId}:component:1:${name}`,
    label: "Component",
    properties: {
      name,
      framework: "svelte",
      kind: !facts ? "template" : facts.runes ? "runes" : "legacy",
      line: 1,
      endLine: documentNode.endPosition.row + (documentNode.endPosition.column === 0 ? 0 : 1),
      isExported: true,
      props: facts && facts.props.length > 0 ? facts.props.join(",") : null,
      pendingRenders: renders.length > 0 ? JSON.stringify(renders) : null,
      hooks: null,
    },
  };
  parsed.nodes.push(component);
  parsed.relationships.push({ from: fileNodeId, to: component.id, type: "DECLARES_COMPONENT", properties: {} });
  if (facts?.scriptFunctionId) {
    parsed.relationships.push({ from: component.id, to: facts.scriptFunctionId, type: "COMPONENT_DEFINED_BY_FUNCTION", properties: {} });
  }
}

// A tag that names a component: PascalCase (`<UserCard>`), dotted
// (`<Ui.Button>`, `<ui.button>`), or `<svelte:component this={View}>`.
function renderedName(tag: string, attributes: readonly SyntaxNode[], source: string): string | null {
  if (tag === "svelte:component") {
    const self = attributes.find((attribute) => attributeName(attribute, source) === "this");
    return /^\{\s*([A-Za-z_$][\w$.]*)\s*\}$/u.exec(self ? attributeValue(self, source) : "")?.[1] ?? null;
  }
  return /^[A-Z]/u.test(tag) || tag.includes(".") ? tag : null;
}

const directivePrefixes = ["on:", "class:", "style:", "use:", "transition:", "in:", "out:", "animate:", "let:"];

// Attributes (`title`, `user={user}`), `{user}` shorthands and `bind:value`
// bindings; directives, spreads, `slot` and `bind:this` are not props. On a
// component, Svelte 5's `onclick={…}` is a prop like any other.
function passedProps(attributes: readonly SyntaxNode[], source: string): string[] {
  const props: string[] = [];
  for (const attribute of attributes) {
    const name = attributeName(attribute, source);
    let prop: string | null = name;
    const shorthand = /^\{\s*([A-Za-z_$][\w$]*)\s*\}$/u.exec(name);
    if (shorthand) prop = shorthand[1]!;
    else if (name.startsWith("bind:")) prop = name === "bind:this" ? null : name.slice(5);
    else if (name === "slot" || directivePrefixes.some((prefix) => name.startsWith(prefix))) prop = null;
    if (prop && /^[\w$-]+$/u.test(prop)) props.push(prop);
  }
  return props;
}

// `onclick={save}`, `onclick={() => save(item)}`, `on:click={save}`,
// `on:submit|preventDefault={send}`. An `on:click` without a value forwards
// the event and is no listener; inline code (`onclick={() => count++}`) names
// no handler but is still a listener.
function addListener(
  fileNodeId: string,
  tag: string,
  attribute: SyntaxNode,
  source: string,
  functionsByName: ReadonlyMap<string, string>,
  parsed: ParsedSourceFile,
): void {
  const name = attributeName(attribute, source);
  const event = /^(?:on:([\w-]+)(?:\|[\w|]+)?|on([a-z]+))$/u.exec(name);
  const trigger = event?.[1] ?? event?.[2];
  const value = attributeValue(attribute, source);
  if (!trigger || value === "") return;
  const expression = /^\{([\s\S]*)\}$/u.exec(value)?.[1]?.trim() ?? value;
  const handlerName = /^[A-Za-z_$][\w$]*$/u.test(expression)
    ? expression
    : /^(?:async\s+)?(?:\([^()]*\)|[A-Za-z_$][\w$]*)\s*=>\s*\{?\s*(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/u.exec(expression)?.[1] ?? null;
  const entrypoint = createEntrypointNode({
    fileNodeId,
    row: attribute.startPosition.row + 1,
    column: attribute.startPosition.column,
    kind: "dom-event",
    trigger,
    receiverName: tag,
    library: "svelte",
    handlerName,
  });
  parsed.nodes.push(entrypoint);
  parsed.relationships.push({ from: fileNodeId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} });
  const handlerId = handlerName ? functionsByName.get(handlerName) : undefined;
  if (handlerId) parsed.relationships.push({ from: entrypoint.id, to: handlerId, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
}

// The name and value of an attribute as written (the tree has the
// expressions masked), without the quotes of a quoted value.
function attributeName(attribute: SyntaxNode, source: string): string {
  const node = attribute.namedChildren.find((child) => child?.type === "attribute_name");
  return node ? source.slice(node.startIndex, node.endIndex) : "";
}

function attributeValue(attribute: SyntaxNode, source: string): string {
  const node = attribute.namedChildren.find((child) => child?.type === "attribute_value" || child?.type === "quoted_attribute_value");
  if (!node) return "";
  const text = source.slice(node.startIndex, node.endIndex);
  return node.type === "quoted_attribute_value" && /^(["']).*\1$/su.test(text) && !text.startsWith("{") ? text.slice(1, -1) : text;
}

function isSvelteFile(fileNodeId: string, parsed: ParsedSourceFile): boolean {
  return parsed.nodes.find((node) => node.id === fileNodeId)?.properties.language === "svelte";
}

import path from "node:path";
import { readFile } from "node:fs/promises";
import { parseSyntaxTree, type SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship, ParsedSourceFile } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import type { PendingRender } from "./react.js";
import { createEntrypointNode, listenerHandlerName } from "./entrypoint-graph.js";
import { stripStringQuotes } from "./file-index.js";

// Angular components, in files that import from `@angular/core`: each class
// decorated with `@Component({…})` is a Component (framework `angular`, kind
// `component`) named after the class, with COMPONENT_DEFINED_BY to it, its
// `selector` and `templateUrl` as written, and as `props` its inputs:
// `@Input()` fields and setters (`@Input('alias')` / `@Input({ alias })` by
// their alias) and `input()`, `input.required()` and `model()` fields.
//
// Templates: the elements of the inline `template` (here) or of the
// `templateUrl` file (the contributor below) whose tag has a hyphen
// (`<app-user [user]="u">`, `ng-template`, `ng-container` and `ng-content`
// left out) are `pendingRenders` with the inputs bound (`[user]`, `[(value)]`,
// plain attributes); event, structural, reference and `[attr.x]`-style
// bindings are not props. `(click)="save()"` on any other element is an
// EntryPoint (kind `dom-event`, library `angular`, the event without its
// modifiers as trigger), handled by the component's method the code calls
// first. `@HostListener('click')` methods and `host: { '(click)': 'onClick()' }`
// entries are entrypoints on the host (`window:` / `document:` targets as the
// receiver).
//
// DI: a field initialized with `inject(UserService)` (any class of the file
// importing `inject`) is an injected field of that type, like a constructor
// parameter property, so the injection resolver adds INJECTS and resolves
// `this.users.load()`.

type InlineFacts = { renders: PendingRender[]; listeners: TemplateListener[] };
type TemplateListener = { row: number; column: number; trigger: string; tag: string; handlerName: string | null };

export async function applyAngularParseSemantics({ fileNodeId, rootNode, parsed }: JsTsParsedFile): Promise<void> {
  const core = angularCoreImports(fileNodeId, parsed);
  if (core.size === 0) return;
  const local = (name: string) => [...core].find(([, imported]) => imported === name)?.[0];
  const decoratorNames = { component: local("Component"), input: local("Input"), hostListener: local("HostListener") };
  const signalInputs = new Set([local("input"), local("model")].filter((name): name is string => name !== undefined));
  const injectName = local("inject");

  for (const statement of rootNode.namedChildren) {
    const declaration = statement?.type === "export_statement" ? statement.childForFieldName("declaration") : statement;
    if (!statement || declaration?.type !== "class_declaration") continue;
    const className = declaration.childForFieldName("name")?.text;
    if (!className) continue;
    const classId = `${fileNodeId}:class:${declaration.startPosition.row + 1}:${className}`;
    const classNode = parsed.nodes.find((node) => node.id === classId);
    if (!classNode) continue;
    const methodIds = new Map(parsed.nodes
      .filter((node) => node.label === "Function" && node.properties.className === className && node.id.startsWith(`${fileNodeId}:function:`))
      .map((node) => [String(node.properties.name), node.id]));
    const addListener = (listener: TemplateListener, library = "angular") => {
      const entrypoint = createEntrypointNode({
        fileNodeId,
        row: listener.row,
        column: listener.column,
        kind: "dom-event",
        trigger: listener.trigger,
        receiverName: listener.tag,
        library,
        handlerName: listener.handlerName,
      });
      parsed.nodes.push(entrypoint);
      parsed.relationships.push({ from: fileNodeId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} });
      const handlerId = listener.handlerName ? methodIds.get(listener.handlerName) : undefined;
      if (handlerId) parsed.relationships.push({ from: entrypoint.id, to: handlerId, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
    };

    const body = declaration.childForFieldName("body");
    const props: string[] = [];
    let pending: SyntaxNode[] = [];
    for (const member of body?.namedChildren ?? []) {
      if (member?.type === "decorator") {
        pending.push(member);
        continue;
      }
      if (!member) continue;
      const decorators = [...pending, ...member.namedChildren.filter((child): child is SyntaxNode => child?.type === "decorator")];
      pending = [];
      const name = member.childForFieldName("name")?.text;
      if (!name) continue;
      const input = decorators.find((decorator) => decoratorCall(decorator)?.name === decoratorNames.input);
      if (input) props.push(inputAlias(decoratorCall(input)!.args) ?? name);
      if (member.type === "public_field_definition") {
        const value = member.childForFieldName("value");
        const callee = value?.type === "call_expression" ? value.childForFieldName("function")?.text ?? "" : "";
        if (signalInputs.has(callee.replace(/\.required$/u, ""))) {
          const args = value!.childForFieldName("arguments")?.namedChildren ?? [];
          props.push(inputAlias(args.filter((arg): arg is SyntaxNode => arg !== null)) ?? name);
        }
        if (callee !== "" && callee === injectName) {
          const field = parsed.nodes.find((node) => node.id === `${classId}:field:${member.startPosition.row + 1}:${name}`);
          const token = injectedType(value!);
          if (field && token) {
            field.properties.typeName = token;
            field.properties.isInjected = true;
          }
        }
      }
      if (member.type !== "method_definition") continue;
      for (const decorator of decorators) {
        const call = decoratorCall(decorator);
        const event = call && call.name === decoratorNames.hostListener && call.args[0]?.type === "string" ? stripStringQuotes(call.args[0].text) : null;
        if (event) addListener({ ...hostEvent(event), row: decorator.startPosition.row + 1, column: decorator.startPosition.column, handlerName: name });
      }
    }

    const classDecorators = [
      ...(statement.type === "export_statement" ? statement.namedChildren : []),
      ...declaration.namedChildren,
    ].filter((child): child is SyntaxNode => child?.type === "decorator");
    const component = classDecorators.map(decoratorCall).find((call) => call?.name === decoratorNames.component);
    const metadata = component?.args[0]?.type === "object" ? component.args[0] : null;
    if (!component) continue;

    const entries = metadata ? objectEntries(metadata) : new Map<string, SyntaxNode>();
    const host = entries.get("host");
    for (const entry of host?.type === "object" ? host.namedChildren : []) {
      const key = entry?.type === "pair" ? entry.childForFieldName("key") : null;
      const value = entry?.childForFieldName("value");
      const event = key?.type === "string" ? /^\((.+)\)$/u.exec(stripStringQuotes(key.text))?.[1] : undefined;
      if (!key || !event) continue;
      const code = value?.type === "string" ? stripStringQuotes(value.text) : "";
      addListener({ ...hostEvent(event), row: key.startPosition.row + 1, column: key.startPosition.column, handlerName: firstCall(code) });
    }

    let facts: InlineFacts = { renders: [], listeners: [] };
    const template = entries.get("template");
    if (template && (template.type === "string" || (template.type === "template_string" && !template.namedChildren.some((child) => child?.type === "template_substitution")))) {
      const start = template.startPosition;
      const prefix = "\n".repeat(start.row) + " ".repeat(start.column + 1);
      facts = await parseTemplate(prefix + template.text.slice(1, -1));
    }
    for (const listener of facts.listeners) addListener(listener);

    const line = Number(classNode.properties.line);
    const node: GraphNode = {
      id: `${fileNodeId}:component:${line}:${className}`,
      label: "Component",
      properties: {
        name: className,
        framework: "angular",
        kind: "component",
        line,
        endLine: typeof classNode.properties.endLine === "number" ? classNode.properties.endLine : null,
        isExported: classNode.properties.isExported === true,
        selector: stringValue(entries.get("selector")),
        templateUrl: stringValue(entries.get("templateUrl")),
        props: props.length > 0 ? props.join(",") : null,
        pendingRenders: facts.renders.length > 0 ? JSON.stringify(facts.renders) : null,
        hooks: null,
      },
    };
    parsed.nodes.push(node);
    parsed.relationships.push({ from: fileNodeId, to: node.id, type: "DECLARES_COMPONENT", properties: {} });
    parsed.relationships.push({ from: node.id, to: classId, type: "COMPONENT_DEFINED_BY", properties: {} });
  }
}

// Local name → imported name of the file's `@angular/core` imports.
function angularCoreImports(fileNodeId: string, parsed: ParsedSourceFile): Map<string, string> {
  const importIds = new Set(parsed.relationships.filter((rel) => rel.from === fileNodeId && rel.type === "IMPORTS").map((rel) => rel.to));
  const names = new Map<string, string>();
  for (const node of parsed.nodes) {
    if (!importIds.has(node.id) || node.properties.source !== "@angular/core" || typeof node.properties.bindings !== "string") continue;
    for (const binding of JSON.parse(node.properties.bindings) as Array<{ imported: string; local: string; kind: string }>) {
      if (binding.kind === "named") names.set(binding.local, binding.imported);
    }
  }
  return names;
}

function decoratorCall(decorator: SyntaxNode | null | undefined): { name: string; args: SyntaxNode[] } | null {
  const call = decorator?.namedChildren[0];
  if (call?.type !== "call_expression") return null;
  const name = call.childForFieldName("function");
  if (name?.type !== "identifier") return null;
  return { name: name.text, args: (call.childForFieldName("arguments")?.namedChildren ?? []).filter((arg): arg is SyntaxNode => arg !== null) };
}

// `inject(UserService)` → `UserService`; `inject<Config>(CONFIG)`, whose
// token is no class, → its type argument `Config`.
function injectedType(call: SyntaxNode): string | null {
  const token = call.childForFieldName("arguments")?.namedChildren[0];
  if (token?.type === "identifier" && /^[A-Z]/u.test(token.text) && token.text !== token.text.toUpperCase()) return token.text;
  if (token?.type === "member_expression") return token.childForFieldName("property")?.text ?? null;
  const typeArgument = call.childForFieldName("type_arguments")?.namedChildren[0];
  return typeArgument?.type === "type_identifier" ? typeArgument.text : null;
}

// `'alias'` or `{ alias: 'alias' }` among an input's arguments.
function inputAlias(args: readonly SyntaxNode[]): string | null {
  for (const arg of args) {
    if (arg.type === "string") return stripStringQuotes(arg.text);
    if (arg.type === "object") {
      const alias = stringValue(objectEntries(arg).get("alias"));
      if (alias) return alias;
    }
  }
  return null;
}

function objectEntries(object: SyntaxNode): Map<string, SyntaxNode> {
  const entries = new Map<string, SyntaxNode>();
  for (const entry of object.namedChildren) {
    if (entry?.type !== "pair") continue;
    const key = entry.childForFieldName("key");
    const value = entry.childForFieldName("value");
    if (key && value) entries.set(key.type === "string" ? stripStringQuotes(key.text) : key.text, value);
  }
  return entries;
}

function stringValue(node: SyntaxNode | undefined): string | null {
  if (node?.type === "string") return stripStringQuotes(node.text);
  if (node?.type === "template_string" && !node.namedChildren.some((child) => child?.type === "template_substitution")) return node.text.slice(1, -1);
  return null;
}

// `window:resize` → receiver `window`, trigger `resize`; `keydown.enter` →
// receiver `host`, trigger `keydown`.
function hostEvent(event: string): { trigger: string; tag: string } {
  const [target, name] = event.includes(":") ? event.split(":", 2) as [string, string] : ["host", event];
  return { tag: target, trigger: name.split(".")[0]! };
}

function firstCall(code: string): string | null {
  return listenerHandlerName(/^\s*([A-Za-z_$][\w$]*)\s*\(/u.exec(code)?.[1]);
}

const builtInElements = new Set(["ng-template", "ng-container", "ng-content"]);

// The renders and listeners of a template. `{{ … }}` interpolations and the
// conditions of `@if (…)`-style blocks are masked for the HTML grammar (a `<`
// in them would read as a tag); node text still comes from `source`.
export async function parseTemplate(source: string): Promise<InlineFacts> {
  const tree = await parseSyntaxTree("html", source, maskTemplateSyntax(source));
  try {
    const facts: InlineFacts = { renders: [], listeners: [] };
    const visit = (node: SyntaxNode) => {
      if (node.type === "start_tag" || node.type === "self_closing_tag") {
        const tag = node.namedChildren.find((child) => child?.type === "tag_name")?.text.toLowerCase() ?? "";
        const attributes = node.namedChildren.filter((child): child is SyntaxNode => child?.type === "attribute");
        if (tag.includes("-") && !builtInElements.has(tag)) {
          facts.renders.push({ name: tag, props: attributes.flatMap((attribute) => boundInput(attributeName(attribute)) ?? []), line: node.startPosition.row + 1 });
        } else {
          for (const attribute of attributes) {
            const event = /^\(([\w-]+)(?:\.[\w.-]+)?\)$/u.exec(attributeName(attribute))?.[1];
            if (!event) continue;
            facts.listeners.push({
              row: attribute.startPosition.row + 1,
              column: attribute.startPosition.column,
              trigger: event,
              tag,
              handlerName: firstCall(attributeValue(attribute)),
            });
          }
        }
      }
      for (const child of node.namedChildren) {
        if (child) visit(child);
      }
    };
    visit(tree.rootNode);
    return facts;
  } finally {
    tree.delete();
  }
}

// `[user]` / `[(value)]` / `title` → the input; events, `*ngIf`, `#ref`,
// `[attr.x]` / `[class.x]` / `[style.x]`, animations and `i18n` are none.
function boundInput(name: string): string | null {
  const bound = /^\[\(?([\w$-]+)\)?\]$/u.exec(name)?.[1];
  if (bound) return bound;
  if (/^[[(*#@]/u.test(name) || name.startsWith("i18n") || name.includes(".")) return null;
  return /^[\w$-]+$/u.test(name) ? name : null;
}

function attributeName(attribute: SyntaxNode): string {
  return attribute.namedChildren.find((child) => child?.type === "attribute_name")?.text ?? "";
}

function attributeValue(attribute: SyntaxNode): string {
  const value = attribute.namedChildren.find((child) => child?.type === "attribute_value" || child?.type === "quoted_attribute_value");
  return value?.type === "quoted_attribute_value"
    ? value.namedChildren.find((child) => child?.type === "attribute_value")?.text ?? ""
    : value?.text ?? "";
}

function maskTemplateSyntax(source: string): string {
  const mask = (text: string) => text.replace(/[^\r\n]/gu, "_");
  let masked = source.replace(/\{\{[\s\S]*?\}\}/gu, (match) => `{{${mask(match.slice(2, -2))}}}`);
  for (const match of masked.matchAll(/@(?:if|else\s+if|for|switch|case|defer)\s*\(/gu)) {
    const open = match.index + match[0].length - 1;
    let depth = 0;
    for (let i = open; i < masked.length; i++) {
      if (masked[i] === "(") depth++;
      else if (masked[i] === ")" && --depth === 0) {
        masked = masked.slice(0, open + 1) + mask(masked.slice(open + 1, i)) + masked.slice(i);
        break;
      }
    }
  }
  return masked;
}

// Template files and render links. For each Angular component with a
// `templateUrl`, the file next to the component is read and its renders and
// listeners added like an inline template's (the entrypoints declared by the
// template file, when it was scanned, the renders noting it in `template`).
// Then each component's pending render whose tag is the element selector of
// exactly one Angular component (`selector: 'app-user'`, also in a list
// `'app-user, [appUser]'`) RENDERS it. When several components select the
// tag, the one the rendering component can see wins, if it is one: what a
// standalone component `imports`, or what the NgModules declaring it declare
// and import (an imported NgModule's `exports`). The rest stay in
// `pendingRenders`.
export const angularTemplatesContributor: ISemanticContributor = {
  async contribute(graph) {
    const nodesById = new Map(graph.nodes.map((node) => [node.id, node]));
    const components: Array<{ component: GraphNode; file: GraphNode }> = [];
    const classOf = new Map<string, string>();
    const methodsOfClass = new Map<string, Map<string, string>>();
    const moduleEdges = {
      MODULE_IMPORTS: new Map<string, string[]>(),
      MODULE_EXPORTS: new Map<string, string[]>(),
      MODULE_DECLARES: new Map<string, string[]>(),
    };
    const declaredBy = new Map<string, string[]>();
    for (const rel of graph.relationships) {
      if (rel.type === "MODULE_IMPORTS" || rel.type === "MODULE_EXPORTS" || rel.type === "MODULE_DECLARES") {
        const edges = moduleEdges[rel.type];
        edges.set(rel.from, [...edges.get(rel.from) ?? [], rel.to]);
        if (rel.type === "MODULE_DECLARES") declaredBy.set(rel.to, [...declaredBy.get(rel.to) ?? [], rel.from]);
      }
      const target = nodesById.get(rel.to);
      if (rel.type === "DECLARES_COMPONENT" && target?.properties.framework === "angular") {
        const file = nodesById.get(rel.from);
        if (file) components.push({ component: target, file });
      }
      if (rel.type === "COMPONENT_DEFINED_BY") classOf.set(rel.from, rel.to);
      if (rel.type === "DEFINES_METHOD" && target) {
        const methods = methodsOfClass.get(rel.from) ?? new Map<string, string>();
        methods.set(String(target.properties.name), target.id);
        methodsOfClass.set(rel.from, methods);
      }
    }
    if (components.length === 0) return;

    const bySelector = new Map<string, string[]>();
    for (const { component } of components) {
      for (const part of String(component.properties.selector ?? "").split(",")) {
        const element = part.trim().toLowerCase();
        if (/^[a-z][\w-]*$/u.test(element)) bySelector.set(element, [...bySelector.get(element) ?? [], component.id]);
      }
    }

    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    for (const { component, file } of components) {
      type Render = PendingRender & { template?: string };
      const renders: Render[] = parsePending(component.properties.pendingRenders);
      const templateUrl = component.properties.templateUrl;
      if (typeof templateUrl === "string" && typeof file.properties.path === "string") {
        const templatePath = path.posix.normalize(path.posix.join(path.posix.dirname(String(file.properties.relativePath)), templateUrl));
        const source = await readFile(path.join(path.dirname(file.properties.path), templateUrl), "utf8").catch(() => null);
        if (source !== null) {
          const facts = await parseTemplate(source);
          renders.push(...facts.renders.map((render) => ({ ...render, template: templatePath })));
          const templateFileId = `file:${templatePath}`;
          const methods = methodsOfClass.get(classOf.get(component.id) ?? "");
          if (nodesById.has(templateFileId)) {
            for (const listener of facts.listeners) {
              const entrypoint = createEntrypointNode({
                fileNodeId: templateFileId,
                row: listener.row,
                column: listener.column,
                kind: "dom-event",
                trigger: listener.trigger,
                receiverName: listener.tag,
                library: "angular",
                handlerName: listener.handlerName,
              });
              nodes.push(entrypoint);
              relationships.push({ from: templateFileId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} });
              const handlerId = listener.handlerName ? methods?.get(listener.handlerName) : undefined;
              if (handlerId) relationships.push({ from: entrypoint.id, to: handlerId, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
            }
          }
        }
      }

      const unresolved: Render[] = [];
      for (const render of renders) {
        let targets = bySelector.get(render.name) ?? [];
        if (targets.length > 1) {
          const visible = visibleClasses(classOf.get(component.id) ?? "", moduleEdges, declaredBy);
          targets = targets.filter((target) => visible.has(classOf.get(target) ?? ""));
        }
        if (targets.length !== 1) {
          unresolved.push(render);
          continue;
        }
        relationships.push({
          from: component.id,
          to: targets[0]!,
          type: "RENDERS",
          properties: { props: render.props.join(","), line: render.line, ...(render.template ? { template: render.template } : {}) },
        });
      }
      component.properties.pendingRenders = unresolved.length > 0 ? JSON.stringify(unresolved) : null;
    }
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

// The classes a component's template can use: its standalone `imports`, and
// the declarations and imports of the NgModules declaring it; an imported
// NgModule contributes itself and its `exports`.
function visibleClasses(
  classId: string,
  edges: Record<"MODULE_IMPORTS" | "MODULE_EXPORTS" | "MODULE_DECLARES", ReadonlyMap<string, readonly string[]>>,
  declaredBy: ReadonlyMap<string, readonly string[]>,
): Set<string> {
  const visible = new Set<string>();
  const addImports = (owner: string) => {
    for (const imported of edges.MODULE_IMPORTS.get(owner) ?? []) {
      visible.add(imported);
      for (const exported of edges.MODULE_EXPORTS.get(imported) ?? []) visible.add(exported);
    }
  };
  addImports(classId);
  for (const module of declaredBy.get(classId) ?? []) {
    for (const declared of edges.MODULE_DECLARES.get(module) ?? []) visible.add(declared);
    addImports(module);
  }
  return visible;
}

function parsePending(value: GraphNode["properties"][string]): PendingRender[] {
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as PendingRender[] : [];
  } catch {
    return [];
  }
}

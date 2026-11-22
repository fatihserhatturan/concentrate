import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { GraphSchemaExtension } from "../../../core/graph/schema.js";
import type { VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import {
  arrayElements,
  attributeValue,
  argumentExpression,
  csharpAttributeReader,
  csharpStringLiteral,
  findAttributes,
  hasAttribute,
  namedArgument,
  positionalArguments,
  type AttributeValue,
  type CSharpAttributeInfo,
} from "./attributes.js";
import { addCSharpRoute, joinRoutePath } from "./emit.js";
import { descendantsOfType, dottedText, invocationChain, invocationInfo, lambdaInfo, type ArgumentInfo, type InvocationInfo } from "./invocations.js";
import { csharpFileOfId, csharpMethods, csharpTypeNodes, parametersOf } from "./shared.js";
import { csharpTypeResolver, type CSharpTypeResolver } from "./type-names.js";
import type { CSharpType } from "../../languages/csharp/types.js";

// HTTP routes of ASP.NET Core.
//
// Controllers (framework `aspnet-mvc`): a concrete public class that derives from `ControllerBase` / `Controller`
// (directly or through user base controllers) or carries `[ApiController]` / `[Controller]`. Every public instance
// method that is not `[NonAction]` is an action. `[Route]` on the class (own, else the nearest base class's: the
// attribute is inherited) joins with the verb attributes (`[HttpGet("x")]`, `[AcceptVerbs]`, `[Route]`) of the method;
// a method template starting with `/` or `~/` replaces the class template; `[controller]`, `[action]` and `[area]`
// tokens are replaced (the controller name without `Controller`, the method name without `Async` or `[ActionName]`,
// `[Area]`). An action with no verb attribute answers every method (`ALL`): at the class route when it has one,
// otherwise at the conventional `/<controller>/<action>`. Attributes are matched by simple name AND namespace
// (`Microsoft.AspNetCore.Mvc`), like Java's annotations: a user attribute of the same name never counts.
// Actions inherited from user base controllers get a Route per concrete controller. Never guessed: constant or
// interpolated templates give `path: null` and a `pathExpression`.
//
// Minimal APIs (framework `aspnet-minimal`): `MapGet/MapPost/MapPut/MapDelete/MapPatch/MapMethods/Map` on an
// endpoint route builder. Call nodes keep neither the arguments nor the receiver chain, so the parse plugin reads
// them (the verb, the path argument, the `MapGroup` prefixes of the receiver chain or of the local variable holding a
// group, nested groups, the handler) and stores a JSON record on the Call node (`aspnetRoute`); the contributor reads
// and removes it. A method-group handler (`Handlers.GetTodo`, `GetTodo`, `handlers.Get`) links to the Function it names; a
// lambda or a local function links to the enclosing Function with `handlerName: "<lambda>"` (the written name for a
// local function), and the typed lambda parameters are kept on the Route as `handlerParameters` (a JSON list shaped like
// a Function's `parameters`) for dependency-injection analysis.
//
// Not handled (never guessed): a group prefix that an extension method receives from its caller
// (`app.MapGroup("/api").MapTodos()`: the routes inside keep the paths relative to their own builder), custom
// conventions (`MapControllerRoute`, `IApplicationModelConvention`), `[ApiVersion]` prefixes, Razor Pages and
// `Program`-level `WithOpenApi` metadata.

const MVC = ["Microsoft.AspNetCore.Mvc"];
const ANY_METHOD = "ALL";
const FRAMEWORK_MVC = "aspnet-mvc";
const FRAMEWORK_MINIMAL = "aspnet-minimal";
const HTTP_ATTRIBUTES: Record<string, string> = { HttpGet: "GET", HttpPost: "POST", HttpPut: "PUT", HttpDelete: "DELETE", HttpPatch: "PATCH", HttpHead: "HEAD", HttpOptions: "OPTIONS" };
const MINIMAL_VERBS: Record<string, string> = { MapGet: "GET", MapPost: "POST", MapPut: "PUT", MapDelete: "DELETE", MapPatch: "PATCH" };
const KNOWN_METHODS = new Set(["GET", "POST", "PUT", "DELETE", "PATCH", "HEAD", "OPTIONS", "TRACE", "CONNECT"]);

export type Part = { value: string; resolved: boolean };

// ---------------------------------------------------------------- paths shared by both halves

export function describePath(parts: readonly Part[]): { path: string | null; expression: string | null } {
  if (parts.every((part) => part.resolved)) return { path: joinRoutePath(...parts.map((part) => part.value.replace(/^~/u, ""))), expression: null };
  const written = parts.filter((part) => !part.resolved || part.value !== "").map((part) => (part.resolved ? JSON.stringify(part.value) : part.value));
  return { path: null, expression: written.join(" + ") };
}

// `GET` of a literal, `HttpMethods.Get`, `System.Net.Http.HttpMethod.Get.Method`...; null when it is not a plain method.
function methodOfExpression(expression: string): string | null {
  const literal = csharpStringLiteral(expression);
  if (literal !== null) return KNOWN_METHODS.has(literal.toUpperCase()) ? literal.toUpperCase() : null;
  const constant = /(?:^|\.)HttpMethods\.(\w+)$/u.exec(expression.replace(/\s+/gu, ""))?.[1];
  return constant && KNOWN_METHODS.has(constant.toUpperCase()) ? constant.toUpperCase() : null;
}

function methodsOfList(expression: string | null): string[] {
  if (expression === null) return [ANY_METHOD];
  const methods = arrayElements(expression).map(methodOfExpression);
  return methods.length > 0 && methods.every((method) => method !== null) ? [...new Set(methods as string[])] : [ANY_METHOD];
}

// ---------------------------------------------------------------- minimal APIs: the parse plugin

type HandlerRecord =
  | { kind: "lambda"; parameters: unknown[] }
  | { kind: "ref"; text: string; local: boolean }
  | { kind: "none" };
type MinimalRecord = { methods: string[]; parts: Part[]; line: number; handler: HandlerRecord };

const TYPE_BOUNDARIES = new Set([
  "class_declaration", "struct_declaration", "record_declaration", "record_struct_declaration", "interface_declaration", "enum_declaration",
  "method_declaration", "constructor_declaration", "destructor_declaration", "operator_declaration", "conversion_operator_declaration",
  "property_declaration", "indexer_declaration", "event_declaration", "namespace_declaration", "file_scoped_namespace_declaration",
]);

type Declarator = { name: string; line: number; initializer: SyntaxNode | null };

// The variables `var x = <expr>;` / `T x = <expr>;` of one function body (not those of nested types or members).
function declaratorsOf(root: SyntaxNode): Declarator[] {
  const found: Declarator[] = [];
  const walk = (node: SyntaxNode, isRoot: boolean): void => {
    if (!isRoot && TYPE_BOUNDARIES.has(node.type)) return;
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name") ?? node.namedChildren.find((child) => child.type === "identifier") ?? null;
      const clause = node.namedChildren.find((child) => child.type === "equals_value_clause");
      const named = node.namedChildren.filter((child) => child.type !== "comment" && child.id !== name?.id);
      const initializer = clause ? clause.namedChildren.at(-1) ?? null : named.at(-1) ?? null;
      if (name) found.push({ name: name.text, line: node.startPosition.row + 1, initializer });
    }
    for (const child of node.namedChildren) walk(child, false);
  };
  walk(root, true);
  return found;
}

const unwrapParentheses = (node: SyntaxNode): SyntaxNode => {
  let current = node;
  while (current.type === "parenthesized_expression" && current.namedChildren[0]) current = current.namedChildren[0];
  return current;
};

const partOfArgument = (argument: ArgumentInfo): Part => (argument.kind === "string" ? { value: argument.value ?? "", resolved: true } : { value: argument.text.replace(/\s+/gu, " ").trim(), resolved: false });

const MAX_GROUP_DEPTH = 8;

// Resolves the `MapGroup` prefix an endpoint builder expression stands for (`app` none, `app.MapGroup("/a")` /a, `api` a
// local holding a group, nested groups). Shared by the minimal API routes and `MapHub` (SignalR).
export function createGroupPrefixResolver(functions: Parameters<VersionedCSharpParsePlugin>[0]["functions"]): (expression: SyntaxNode | null, fn: GraphNode, line: number) => Part[] {
  const syntaxOf = new Map(functions.map((entry) => [entry.node.id, entry.syntax]));
  const declarators = new Map<string, Declarator[]>();
  const declaratorsFor = (fn: GraphNode): Declarator[] => {
    let list = declarators.get(fn.id);
    if (!list) {
      const syntax = syntaxOf.get(fn.id);
      list = syntax ? declaratorsOf(syntax) : [];
      declarators.set(fn.id, list);
    }
    return list;
  };
  const prefixOf = (expression: SyntaxNode | null, fn: GraphNode, line: number, depth: number): Part[] => {
    if (!expression || depth > MAX_GROUP_DEPTH) return [];
    const node = unwrapParentheses(expression);
    if (node.type === "identifier") {
      const declared = declaratorsFor(fn).filter((candidate) => candidate.name === node.text && candidate.line <= line).at(-1);
      return declared?.initializer ? prefixOf(declared.initializer, fn, declared.line, depth + 1) : [];
    }
    if (node.type !== "invocation_expression") return [];
    const { root: chainRoot, chain } = invocationChain(node);
    const parts = prefixOf(chainRoot, fn, line, depth + 1);
    for (const link of chain) {
      if (link.name !== "MapGroup") continue;
      const argument = link.arguments[0];
      parts.push(argument ? partOfArgument(argument) : { value: "", resolved: true });
    }
    return parts;
  };
  return (expression, fn, line) => prefixOf(expression, fn, line, 0);
}

export const csharpRoutesPlugin: VersionedCSharpParsePlugin = ({ root, functions, calls }) => {
  if (!root.text.includes("Map")) return;
  const syntaxOf = new Map(functions.map((entry) => [entry.node.id, entry.syntax]));
  const groupPrefix = createGroupPrefixResolver(functions);

  const argumentAt = (info: InvocationInfo, name: string, index: number): ArgumentInfo | undefined =>
    info.arguments.find((argument) => argument.name === name) ?? info.arguments.filter((argument) => argument.name === null)[index];

  for (const { syntax, node, function: fn } of calls) {
    const info = invocationInfo(syntax);
    if (!info || !info.receiver) continue;
    const isMethods = info.name === "MapMethods";
    const isMap = info.name === "Map";
    if (!isMethods && !isMap && !(info.name in MINIMAL_VERBS)) continue;
    const path = argumentAt(info, "pattern", 0);
    const handlerArgument = isMethods ? argumentAt(info, "handler", 2) : argumentAt(info, "handler", 1);
    if (!path || !handlerArgument || path.kind === "lambda" || path.kind === "typeof") continue;
    if (isMethods && !argumentAt(info, "httpMethods", 1)) continue;
    // `IApplicationBuilder.Map("/x", branch => ...)` branches the middleware pipeline: one untyped lambda parameter.
    const lambda = handlerArgument.kind === "lambda" ? lambdaInfo(handlerArgument.node) : null;
    if (isMap && lambda && lambda.parameters.length === 1 && lambda.parameters[0]!.type === "") continue;
    let handler: HandlerRecord = { kind: "none" };
    if (lambda) handler = { kind: "lambda", parameters: lambda.parameters };
    else if (handlerArgument.kind === "method-group") {
      const text = dottedText(handlerArgument.node);
      if (text) {
        const syntaxRoot = syntaxOf.get(fn.id);
        const local = !text.includes(".") && syntaxRoot !== undefined && descendantsOfType(syntaxRoot, new Set(["local_function_statement"])).some((candidate) => candidate.childForFieldName("name")?.text === text);
        handler = { kind: "ref", text, local };
      }
    }
    const nameNode = syntax.childForFieldName("function")?.childForFieldName("name") ?? syntax;
    const line = nameNode.startPosition.row + 1;
    const methods = isMethods ? methodsOfList(argumentAt(info, "httpMethods", 1)!.text) : isMap ? [ANY_METHOD] : [MINIMAL_VERBS[info.name]!];
    const parts = [...groupPrefix(info.receiver, fn, line), partOfArgument(path)];
    const record: MinimalRecord = { methods, parts, line, handler };
    node.properties.aspnetRoute = JSON.stringify(record);
  }
};
Object.assign(csharpRoutesPlugin, { version: "1" });

// ---------------------------------------------------------------- minimal APIs: the contributor half

function minimalRoutes(graph: IGraphContributor, resolver: CSharpTypeResolver | null): void {
  const calls = graph.nodesWithLabel("Call").filter((node) => typeof node.properties.aspnetRoute === "string");
  if (calls.length === 0) return;
  const lazyResolver = resolver ?? csharpTypeResolver(graph);
  for (const call of calls) {
    const record = JSON.parse(String(call.properties.aspnetRoute)) as MinimalRecord;
    delete call.properties.aspnetRoute;
    const fileId = csharpFileOfId(call.id);
    const functionId = call.id.slice(0, call.id.indexOf(":call:"));
    const enclosing = graph.node(functionId);
    if (!fileId || !enclosing) continue;
    const { path, expression } = describePath(record.parts);
    let handler: GraphNode | null = null;
    let handlerName: string | null = null;
    let lambdaParameters: unknown[] | null = null;
    if (record.handler.kind === "lambda") {
      handler = enclosing;
      handlerName = "<lambda>";
      lambdaParameters = record.handler.parameters;
    } else if (record.handler.kind === "ref") {
      if (record.handler.local) {
        handler = enclosing;
        handlerName = record.handler.text;
      } else {
        handler = resolveMethodGroup(lazyResolver, call, enclosing, record.handler.text);
        if (!handler) handlerName = record.handler.text.slice(record.handler.text.lastIndexOf(".") + 1);
      }
    }
    for (const method of record.methods) {
      const route = addCSharpRoute(graph, { fileId, method, path, pathExpression: expression, framework: FRAMEWORK_MINIMAL, line: record.line, handler, handlerName });
      if (handlerName !== null) route.properties.handlerName = handlerName;
      if (lambdaParameters && lambdaParameters.length > 0) route.properties.handlerParameters = JSON.stringify(lambdaParameters);
    }
  }
}

// The one method a handler method group (`GetTodo`, `Handlers.GetTodo`, `this.Get`, `handlers.Get`) names.
function resolveMethodGroup(resolver: CSharpTypeResolver, call: GraphNode, enclosing: GraphNode, text: string): GraphNode | null {
  const cut = text.lastIndexOf(".");
  const member = text.slice(cut + 1);
  const qualifier = cut === -1 ? null : text.slice(0, cut);
  const owner = resolver.ownerOf(enclosing);
  const ownerType = owner ? resolver.typeOf(owner) : undefined;
  const methodsNamed = (type: CSharpType | undefined, staticOnly: boolean): GraphNode[] => {
    const found: GraphNode[] = [];
    const seen = new Set<string>();
    const stack = type ? [type] : [];
    while (stack.length > 0) {
      const current = stack.shift()!;
      if (seen.has(current.id)) continue;
      seen.add(current.id);
      for (const fn of resolver.methodsOf(current)) {
        if (fn.properties.kind === "method" && fn.properties.name === member && (!staticOnly || fn.properties.isStatic === true)) found.push(fn);
      }
      if (found.length > 0) break;
      stack.push(...resolver.index.supertypes(current).filter((candidate) => !candidate.isInterface));
    }
    return found;
  };
  let candidates: GraphNode[];
  if (qualifier === null || qualifier === "this") candidates = methodsNamed(ownerType, false);
  else {
    const named = resolver.resolve(qualifier, call);
    if (named) candidates = methodsNamed(named, false);
    else {
      // An instance: a local or parameter of the enclosing function, or a field of its type.
      let typeName: string | null = null;
      try {
        const locals = JSON.parse(String(enclosing.properties.csharpLocals ?? "{}")) as Record<string, { type?: string } | null>;
        typeName = locals[qualifier]?.type ?? null;
      } catch {
        typeName = null;
      }
      typeName ??= parametersOf(enclosing).find((parameter) => parameter.name === qualifier)?.type ?? null;
      const instance = typeName ? resolver.resolve(typeName, call) : null;
      candidates = instance ? methodsNamed(instance, false) : [];
    }
  }
  return candidates.length === 1 ? candidates[0]! : null;
}

// ---------------------------------------------------------------- controllers

type Selector = { verbs: string[]; template: Part | null; line: number | null };

const toValue = (expression: string | null): Part | null => {
  const value: AttributeValue | null = attributeValue(expression);
  return value ? { value: value.value, resolved: value.resolved } : null;
};

function substituteTokens(part: Part, tokens: { controller: string; action: string; area: string | null }): Part {
  if (!part.resolved) return part;
  const value = part.value.replace(/\[(controller|action|area)\]/giu, (whole, name: string) => {
    const key = name.toLowerCase();
    if (key === "controller") return tokens.controller;
    if (key === "action") return tokens.action;
    return tokens.area ?? whole;
  });
  return { value, resolved: true };
}

function controllerRoutes(graph: IGraphContributor, resolver: CSharpTypeResolver): void {
  const reader = csharpAttributeReader(graph);
  const methodFiles = new Map(csharpMethods(graph).map((method) => [method.node.id, method.fileId]));
  const attrsCache = new Map<string, CSharpAttributeInfo[]>();
  const attrs = (node: GraphNode): CSharpAttributeInfo[] => {
    let list = attrsCache.get(node.id);
    if (!list) attrsCache.set(node.id, (list = reader.attributesOf(node).filter((attribute) => attribute.target === null || attribute.target === "method")));
    return list;
  };
  const chainOf = (type: CSharpType): CSharpType[] => {
    const chain: CSharpType[] = [];
    const seen = new Set<string>();
    for (let current: CSharpType | undefined = type; current && !seen.has(current.id); ) {
      seen.add(current.id);
      chain.push(current);
      current = resolver.index.supertypes(current).find((candidate) => !candidate.isInterface && candidate.kind === "class");
    }
    return chain;
  };
  const routingAttribute = (list: readonly CSharpAttributeInfo[]): boolean =>
    list.some((attribute) => ["Route", "AcceptVerbs", "ActionName", ...Object.keys(HTTP_ATTRIBUTES)].some((name) => findAttributes([attribute], name, MVC).length > 0));

  for (const typeNode of csharpTypeNodes(graph)) {
    if (typeNode.label !== "Class" || typeNode.properties.kind !== "class" || typeNode.properties.isAbstract === true || typeNode.properties.visibility !== "public" || Number(typeNode.properties.arity) !== 0) continue;
    const type = resolver.typeOf(typeNode);
    if (!type) continue;
    const chain = chainOf(type);
    const isApi = chain.some((member) => hasAttribute(attrs(member.node), "ApiController", MVC));
    const isController = isApi || resolver.derivesFromExternal(type, ["ControllerBase", "Controller"]) || chain.some((member) => hasAttribute(attrs(member.node), "Controller", MVC));
    if (!isController || hasAttribute(attrs(typeNode), "NonController", MVC)) continue;

    const classRoutesOf = chain.find((member) => findAttributes(attrs(member.node), "Route", MVC).length > 0);
    const classTemplates: Part[] = classRoutesOf
      ? findAttributes(attrs(classRoutesOf.node), "Route", MVC).map((attribute) => toValue(argumentExpression(attribute, 0, "Template")) ?? { value: "", resolved: true })
      : [];
    const areaAttribute = chain.flatMap((member) => findAttributes(attrs(member.node), "Area", MVC))[0];
    const areaValue = areaAttribute ? toValue(argumentExpression(areaAttribute, 0)) : null;
    const controllerName = type.name.length > "Controller".length && type.name.endsWith("Controller") ? type.name.slice(0, -"Controller".length) : type.name;

    // The actions: public instance methods of the type and of its user base controllers, the most derived signature first.
    const bySignature = new Map<string, GraphNode[]>();
    for (const member of chain) {
      for (const fn of resolver.methodsOf(member)) {
        const props = fn.properties;
        if (props.kind !== "method" || props.visibility !== "public" || props.isStatic === true || props.isAbstract === true) continue;
        const key = `${String(props.name)}/${String(props.parameterCount ?? 0)}`;
        const list = bySignature.get(key);
        if (list) list.push(fn);
        else bySignature.set(key, [fn]);
      }
    }
    for (const list of bySignature.values()) {
      const handler = list[0]!;
      // An override of a framework method (`OnActionExecuting`, `Dispose`) is not an action.
      if (handler.properties.isOverride === true && list.length === 1) continue;
      const own = attrs(handler);
      const effective = routingAttribute(own) ? own : list.map(attrs).find(routingAttribute) ?? own;
      if (hasAttribute(own, "NonAction", MVC)) continue;
      const fileId = methodFiles.get(handler.id);
      if (!fileId) continue;
      const nameAttribute = findAttributes(effective, "ActionName", MVC)[0];
      const written = nameAttribute ? toValue(argumentExpression(nameAttribute, 0, "Name")) : null;
      const rawName = String(handler.properties.name);
      const actionName = written?.resolved ? written.value : rawName.length > "Async".length && rawName.endsWith("Async") ? rawName.slice(0, -"Async".length) : rawName;
      const tokens = { controller: controllerName, action: actionName, area: areaValue?.resolved ? areaValue.value : null };

      const selectors = selectorsOf(effective, Number(handler.properties.line));
      if (selectors.length === 0) {
        if (classTemplates.length > 0) selectors.push({ verbs: [ANY_METHOD], template: null, line: null });
        else if (!isApi) selectors.push({ verbs: [ANY_METHOD], template: { value: `~/${controllerName}/${actionName}`, resolved: true }, line: null });
        else continue;
      }
      for (const selector of selectors) {
        // A silent `[HttpPost]` makes no attribute route: without a class `[Route]` an MVC action stays conventionally routed.
        if (selector.template === null && classTemplates.length === 0 && !isApi) selector.template = { value: `~/${controllerName}/${actionName}`, resolved: true };
        const template = selector.template ? substituteTokens(selector.template, tokens) : null;
        const absolute = template !== null && (template.resolved ? /^~?\//u.test(template.value) : /^(?:\$@?|@\$?)?"~?\//u.test(template.value));
        const prefixes: Part[] = absolute || classTemplates.length === 0 ? [{ value: "", resolved: true }] : classTemplates.map((part) => substituteTokens(part, tokens));
        for (const prefix of prefixes) {
          const { path, expression } = describePath(template ? [prefix, template] : [prefix]);
          for (const verb of selector.verbs) {
            addCSharpRoute(graph, { fileId, method: verb, path, pathExpression: expression, framework: FRAMEWORK_MVC, line: selector.line ?? Number(handler.properties.line), handler });
          }
        }
      }
    }
  }
}

// What the route attributes of one action say: a `[Route(t)]` answers every method (or the ones silent verb attributes
// name), `[HttpGet(t)]` / `[AcceptVerbs(.., Route = t)]` their verbs at `t`, a silent `[HttpGet]` its verb at the class route.
function selectorsOf(list: readonly CSharpAttributeInfo[], defaultLine: number): Selector[] {
  type Raw = { verbs: string[] | null; template: Part | null; line: number };
  const raws: Raw[] = [];
  for (const attribute of list) {
    const http = Object.keys(HTTP_ATTRIBUTES).find((name) => findAttributes([attribute], name, MVC).length > 0);
    if (http) raws.push({ verbs: [HTTP_ATTRIBUTES[http]!], template: toValue(argumentExpression(attribute, 0, "Template")), line: attribute.line });
    else if (findAttributes([attribute], "AcceptVerbs", MVC).length > 0) {
      const verbs = positionalArguments(attribute);
      raws.push({ verbs: methodsOfList(verbs.length === 0 ? null : `[${verbs.join(", ")}]`), template: toValue(namedArgument(attribute, "Route")), line: attribute.line });
    } else if (findAttributes([attribute], "Route", MVC).length > 0) raws.push({ verbs: null, template: toValue(argumentExpression(attribute, 0, "Template")) ?? { value: "", resolved: true }, line: attribute.line });
  }
  const silent = raws.filter((raw) => raw.verbs !== null && raw.template === null);
  const templated = raws.filter((raw) => raw.template !== null);
  if (templated.length === 0) return silent.map((raw) => ({ verbs: raw.verbs!, template: null, line: raw.line }));
  const silentVerbs = [...new Set(silent.flatMap((raw) => raw.verbs!))];
  return templated.map((raw) => ({ verbs: raw.verbs ?? (silentVerbs.length > 0 ? silentVerbs : [ANY_METHOD]), template: raw.template, line: raw.line || defaultLine }));
}

export const csharpRoutesContributor: ISemanticContributor = {
  id: "csharp.routes",
  contribute(graph) {
    const hasMinimal = graph.nodesWithLabel("Call").some((node) => typeof node.properties.aspnetRoute === "string");
    const hasClasses = graph.nodesWithLabel("Class").some((node) => node.properties.nesting !== undefined && typeof node.properties.arity === "number");
    if (!hasMinimal && !hasClasses) return;
    const resolver = csharpTypeResolver(graph);
    controllerRoutes(graph, resolver);
    minimalRoutes(graph, resolver);
  },
};

// `handlerParameters`: the typed parameters of a lambda handler of a minimal API route (JSON, like a Function's `parameters`).
export const csharpRoutesSchema: GraphSchemaExtension = {
  id: "csharp-routes",
  nodeProperties: [{ label: "Route", after: "handlerName", properties: { handlerParameters: "STRING" } }],
};

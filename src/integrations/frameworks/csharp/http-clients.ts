import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphSchemaExtension } from "../../../core/graph/schema.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import type { CSharpParsedCall, VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";
import { compactExpression, compactNoSpace, normalizeCSharpType, typeText } from "../../languages/csharp/syntax.js";
import type { CSharpType } from "../../languages/csharp/types.js";
import { attributeValue, csharpAttributeReader, findAttributes, positionalArguments } from "./attributes.js";
import { isSecretConfigKey, readAppSettings, joinKey } from "./config-files.js";
import { invocationInfo, type ArgumentInfo } from "./invocations.js";
import { createCSharpReceiverResolver, receiverMatches, type CSharpReceiverType } from "./receivers.js";
import { csharpFileOfId, jsonList } from "./shared.js";
import {
  createCSharpStringResolver,
  csharpStringFromText,
  localNamesOf,
  parseCSharpString,
  readCSharpString,
  renderCSharpString,
  serializeCSharpString,
  stringScopeOf,
  type CSharpStringPart,
  type CSharpStringScope,
  type CSharpStringTemplate,
} from "./strings.js";

// C# outbound HTTP, recorded on the Call node like the Java, JS/TS, Go, Rust and Python clients (`httpClient`,
// `httpMethod`, `httpUrl`), so `js-ts.http-requests` links it to the Route it reaches (REQUESTS, with the
// `--api-origin` rules). Two steps: the parse plugin reads the shape of each candidate call (method, URL template,
// bases) into PRIVATE properties (`csharpHttp` on a Call, `csharpHttpReg` on the Call of a DI registration,
// `csharpHttpBinds` on a Function); the contributor, once every file is parsed, checks the receiver's type
// (`receivers.ts`), resolves constants (`strings.ts`) and configuration reads (`config-files.ts`), writes the three
// public properties and removes the private ones, whatever returns early.
//
//   - HttpClient (receiver typed `HttpClient`, a subclass, or a field of a typed client): `GetAsync`, `GetStringAsync`,
//     `GetStreamAsync`, `GetByteArrayAsync`, `GetFromJsonAsync`, `PostAsync`, `PostAsJsonAsync`, `PutAsync`,
//     `PutAsJsonAsync`, `PatchAsync`, `PatchAsJsonAsync`, `DeleteAsync`, `DeleteFromJsonAsync` (and the sync `Send`)
//     are requests with the call's own URL. Recorded on the call. `SendAsync(new HttpRequestMessage(HttpMethod.X, url))`
//     is recorded on the `new HttpRequestMessage(...)` call, one request per message expression (as Java's
//     `HttpRequest.newBuilder`): the method is `HttpMethod.X` / `new HttpMethod("X")`, the URL the constructor's
//     second argument or the `RequestUri` of an initializer or a later `request.RequestUri = ...` assignment; the message is
//     read when it is built in the same function that sends it (directly or through a local).
//   - URLs: literals, constants, locals, interpolations, `+`, `new Uri("...")`, `new Uri(base, rel)` (joined),
//     `QueryHelpers.AddQueryString(url, ...)`. A hole stays `${expression}` (matches a route parameter). A query string
//     or fragment is dropped, as is the userinfo of an absolute URL.
//   - Base addresses: `new HttpClient { BaseAddress = new Uri(...) }` and `client.BaseAddress = ...` bound to the local,
//     or to the field when it is set in any method of the same class; `services.AddHttpClient("name", c => c.BaseAddress =
//     ...)` (named), `AddHttpClient<TClient>(c => ...)` and `AddHttpClient<IClient, TClient>(c => ...)` (typed: the base
//     of the class's requests through its `HttpClient` field), `.ConfigureHttpClient(c => ...)` chained on either;
//     `factory.CreateClient("name")` assigned to a local or field, or used in place, takes the named registration's base
//     (`CreateClient()` is the default client, name ""). A base is a literal, a constant or a configuration read
//     (`config["A:B"]`, `GetValue<string>("A:B")`, `GetSection("A")["B"]`, optionally `?? "default"`) looked up in
//     `appsettings*.json` (the closest file to the use, `config-files.ts`); an unknown key is `${config:A:B}`, never
//     a guess; a key that is not a literal, or an expression that is no config read, is `${expr}`, never its text.
//     A request is resolved against the base as .NET does (RFC 3986, `resolveReference`): `/x` replaces the base's path,
//     `x` is relative to the base's last `/` (`http://h/api` + `v1/x` is `http://h/v1/x`), an absolute URL ignores the
//     base, `""` is the base. Refit appends its path after the base's path. A URL starting with an unknown part gets
//     no base. Without a known base the path stays relative. Named clients compare ordinally. `httpClient` is `httpclient-factory`
//     for a typed or named client of `AddHttpClient` / `CreateClient`, else `httpclient`.
//   - Refit: an interface whose methods carry `[Get("/x/{id}")]`, `[Post]`, `[Put]`, `[Patch]`, `[Delete]`, `[Head]`,
//     `[Options]` (namespace Refit; `[Headers]` and other attributes ignored; also on a base interface) has no Call of
//     its own, so the request (`httpClient: "refit"`) is recorded on each Call of the scan that invokes one of its
//     methods (receiver typed as the interface, or CALL_RESOLVES_TO its method): the attribute's method and base + path
//     (`{id}` becomes `${id}`). The base comes from `RestService.For<IApi>("url")`, `RestService.For<IApi>(new HttpClient {
//     BaseAddress = ... })` (the base of the calls through the local or field it is assigned to), or
//     `services.AddRefitClient<IApi>().ConfigureHttpClient(c => c.BaseAddress = ...)` (the fallback). An
//     overload is linked only when exactly one has the call's argument count.
// Test files (`File.isTest`) are skipped.
//
// Not handled: `WebClient` / `WebRequest`, RestSharp, Flurl, `DelegatingHandler` / middleware URL rewriting,
// `HttpRequestMessage` built in one method and sent in another, `request.Method = ...` in a different function, base
// addresses set by `IOptions` objects or `GetSection` variables, a `BaseAddress` set in a field initializer other than
// `new HttpClient { ... }` bound there, `CreateClient<T>()`, Refit `[Headers]` / `[BaseUrl]`-style class settings, and
// service discovery or `${...}` placeholders in registration names.

type RawKind = "client" | "message" | "restFor";

type Raw = {
  k: RawKind;
  method: string | null;
  /** The URL as a template (`serializeCSharpString`). */
  url: string | null;
  /** The receiver text whose type decides whether this is HttpClient (the receiver of `SendAsync` for a message). */
  root: string | null;
  /** The receiver is `factory.CreateClient(name)` written in place. */
  factory?: { factory: string; name: string | null };
  /** `restFor`: the interface of `RestService.For<T>(...)`. */
  target?: string;
  /** `restFor`: the local or field the result is assigned to. */
  bound?: string | null;
};

type Reg = {
  /** `AddHttpClient` or `AddRefitClient`. */
  kind: "http" | "refit";
  typeArguments: string[];
  /** The client name template (named client), null for none. */
  name: string | null;
  /** The base address template, null when the registration sets none. */
  base: string | null;
};

type Bind = {
  name: string;
  /** Declared in the function (a local or a parameter) rather than a field. */
  local: boolean;
  base: string | null;
  named: { factory: string; name: string | null } | null;
};

const RAW = "csharpHttp";
const REG = "csharpHttpReg";
const BINDS = "csharpHttpBinds";

const CLIENT_METHODS = new Map<string, string>([
  ["GetAsync", "GET"], ["GetStringAsync", "GET"], ["GetStreamAsync", "GET"], ["GetByteArrayAsync", "GET"], ["GetFromJsonAsync", "GET"], ["GetFromJsonAsAsyncEnumerable", "GET"],
  ["PostAsync", "POST"], ["PostAsJsonAsync", "POST"],
  ["PutAsync", "PUT"], ["PutAsJsonAsync", "PUT"],
  ["PatchAsync", "PATCH"], ["PatchAsJsonAsync", "PATCH"],
  ["DeleteAsync", "DELETE"], ["DeleteFromJsonAsync", "DELETE"],
]);
const SEND_METHODS = new Set(["SendAsync", "Send"]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]);
const REFIT_VERBS = new Map([["Get", "GET"], ["Post", "POST"], ["Put", "PUT"], ["Patch", "PATCH"], ["Delete", "DELETE"], ["Head", "HEAD"], ["Options", "OPTIONS"]]);
const MESSAGE_TYPE = /^(?:System\.Net\.Http\.)?HttpRequestMessage$/u;
const CANDIDATE_FILE = /\b(?:HttpClient|HttpRequestMessage|AddHttpClient|CreateClient|IHttpClientFactory|RestService|AddRefitClient|ConfigureHttpClient)\b/u;

// ---------------------------------------------------------------- syntax helpers

const isComment = (node: SyntaxNode): boolean => node.type === "comment";
const unwrap = (node: SyntaxNode | null | undefined): SyntaxNode | null => {
  let current = node ?? null;
  for (;;) {
    if (current?.type === "parenthesized_expression") current = current.namedChildren.find((child) => !isComment(child)) ?? null;
    else if (current?.type === "postfix_unary_expression" && current.text.endsWith("!")) current = current.namedChildren.find((child) => !isComment(child)) ?? null;
    else return current;
  }
};
const written = (node: SyntaxNode | null | undefined): string => (node ? compactExpression(node.text) : "");

const isCreation = (node: SyntaxNode | null | undefined): boolean =>node?.type === "object_creation_expression" || node?.type === "implicit_object_creation_expression";
const creationArguments = (node: SyntaxNode): SyntaxNode[] => {
  const list = node.namedChildren.find((child) => child.type === "argument_list");
  return list ? list.namedChildren.filter((child) => child.type === "argument").map((argument) => unwrap(argument.namedChildren.find((child) => child.type !== "name_colon" && !isComment(child)) ?? null)).filter((child): child is SyntaxNode => child !== null) : [];
};
const creationType = (node: SyntaxNode): string | null => (node.type === "object_creation_expression" ? normalizeCSharpType(typeText(node.childForFieldName("type"))) : null);

// `{ A = x, B = y }` of an object creation: the assigned expressions by member name.
function initializerOf(node: SyntaxNode): Map<string, SyntaxNode> {
  const members = new Map<string, SyntaxNode>();
  const initializer = node.namedChildren.find((child) => child.type === "initializer_expression");
  for (const assignment of initializer?.namedChildren ?? []) {
    if (assignment.type !== "assignment_expression") continue;
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    if (left?.type === "identifier" && right) members.set(left.text, right);
  }
  return members;
}

const concat = (...parts: CSharpStringTemplate[]): CSharpStringTemplate => parts.flat();

// RFC 3986 relative resolution, as .NET's `new Uri(base, relative)` and `HttpClient.BaseAddress` do. Unknown parts
// (`${config:A:B}`, `${expr}`) are masked as one opaque character run each, so they never hold a `/` or `:`.
const MARK_OPEN = "\uE000";
const MARK_CLOSE = "\uE001";
const ABSOLUTE_MASKED = /^[a-z][a-z0-9+.-]*:\/\//iu;

function removeDotSegments(path: string): string {
  const output: string[] = [];
  const segments = path.split("/");
  segments.forEach((segment, index) => {
    const last = index === segments.length - 1;
    if (segment === "..") {
      if (output.length > 1) output.pop();
      if (last) output.push("");
    } else if (segment === ".") {
      if (last) output.push("");
    } else output.push(segment);
  });
  return output.join("/");
}

/** The relative reference `relative` resolved against `base` (both masked); an absolute one ignores the base. */
function resolveReference(base: string, relative: string): string {
  if (relative === "") return base;
  if (ABSOLUTE_MASKED.test(relative)) return relative;
  if (relative.startsWith("?") || relative.startsWith("#")) return `${base.replace(/[?#].*$/su, "")}${relative}`;
  const authority = /^((?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*)([^?#]*)/iu.exec(base);
  let origin = "";
  let path: string;
  if (authority) {
    origin = authority[1]!;
    path = authority[2]!;
  } else {
    const bare = base.replace(/[?#].*$/su, "");
    // A base that starts with an unknown part: that part is its origin (the part up to the first `/`).
    if (bare.startsWith(MARK_OPEN)) {
      const slash = bare.indexOf("/");
      origin = slash === -1 ? bare : bare.slice(0, slash);
      path = slash === -1 ? "" : bare.slice(slash);
    } else path = bare;
  }
  if (relative.startsWith("//")) return `${/^[a-z][a-z0-9+.-]*:/iu.exec(base)?.[0] ?? ""}${relative}`;
  if (relative.startsWith("/")) return `${origin}${removeDotSegments(relative)}`;
  const directory = path.slice(0, path.lastIndexOf("/") + 1);
  return `${origin}${removeDotSegments(origin !== "" && directory === "" ? `/${relative}` : `${directory}${relative}`)}`;
}

// `new Uri(base, relative)` on templates: the relative part resolved against the base text; an unknown start of the
// relative part (it may be absolute) or a base without literal text just concatenates.
function joinTemplates(left: CSharpStringTemplate, right: CSharpStringTemplate): CSharpStringTemplate {
  const first = right[0];
  if (left.length === 0 || !first || !("text" in first) || first.text === "") return concat(left, right);
  const holes: CSharpStringPart[] = [];
  const mask = (template: CSharpStringTemplate): string => template.map((part) => {
    if ("text" in part) return part.text;
    holes.push(part);
    return `${MARK_OPEN}${holes.length - 1}${MARK_CLOSE}`;
  }).join("");
  const resolved = resolveReference(mask(left), mask(right));
  const result: CSharpStringTemplate = [];
  resolved.split(new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "u")).forEach((piece, index) => {
    if (index % 2 === 1) result.push(holes[Number(piece)]!);
    else if (piece !== "") result.push({ text: piece });
  });
  return result;
}

const URI_TYPE = /^(?:System\.)?Uri$/u;

// Single-assignment locals of a member initialized by `new Uri(...)`, by scope: `var u = new Uri(base, "v1/x"); GetAsync(u)`.
const uriLocals = new WeakMap<CSharpStringScope, Map<string, SyntaxNode>>();

function readUriLocals(root: SyntaxNode): Map<string, SyntaxNode> {
  const declarations = new Map<string, SyntaxNode[]>();
  const assigned = new Set<string>();
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name")?.text ?? node.namedChildren[0]?.text;
      const value = node.namedChildren.length === 2 ? node.namedChildren[1] : undefined;
      if (name) declarations.set(name, [...(declarations.get(name) ?? []), ...(value ? [value] : [node])]);
    } else if (node.type === "assignment_expression") {
      const left = node.childForFieldName("left");
      if (left?.type === "identifier") assigned.add(left.text);
    }
    for (const child of node.namedChildren) stack.push(child);
  }
  const found = new Map<string, SyntaxNode>();
  for (const [name, values] of declarations) {
    const value = values.length === 1 && !assigned.has(name) ? unwrap(values[0]) : null;
    if (value && isCreation(value) && URI_TYPE.test(creationType(value) ?? "")) found.set(name, value);
  }
  return found;
}

// The template of a URL expression: a string expression, `new Uri(s)`, `new Uri(base, rel)`, `a + b`,
// `QueryHelpers.AddQueryString(url, ...)`; a call, an element read or a member the string reader does not know is `{ expr }`.
function urlOf(node: SyntaxNode, scope: CSharpStringScope, depth = 0): CSharpStringTemplate {
  const inner = unwrap(node) ?? node;
  if (depth < 8) {
    const held = inner.type === "identifier" ? uriLocals.get(scope)?.get(inner.text) : undefined;
    if (held) return urlOf(held, scope, depth + 1);
    if (isCreation(inner)) {
      const type = creationType(inner);
      const args = creationArguments(inner);
      if (type && URI_TYPE.test(type) && args[0]) {
        const second = args[1];
        if (second && !/^(?:System\.)?UriKind\./u.test(written(second))) return joinTemplates(urlOf(args[0], scope, depth + 1), urlOf(second, scope, depth + 1));
        return urlOf(args[0], scope, depth + 1);
      }
    } else if (inner.type === "binary_expression" && inner.childForFieldName("operator")?.text === "+") {
      const left = inner.childForFieldName("left");
      const right = inner.childForFieldName("right");
      if (left && right) return concat(urlOf(left, scope, depth + 1), urlOf(right, scope, depth + 1));
    } else if (inner.type === "invocation_expression") {
      const info = invocationInfo(inner);
      if (info && info.name === "AddQueryString" && info.arguments[0]) return urlOf(info.arguments[0].node, scope, depth + 1);
    }
  }
  // The empty string (`GetAsync("")`) is the base address itself.
  if (/^(?:@?""|(?:System\.)?[sS]tring\.Empty)$/u.test(compactNoSpace(inner.text))) return [{ text: "" }];
  return readCSharpString(inner, scope) ?? [{ expr: written(inner) }];
}

// `HttpMethod.Post`, `new HttpMethod("PURGE")` (known verbs only).
function methodOf(node: SyntaxNode | null | undefined): string | null {
  const text = compactNoSpace(unwrap(node)?.text ?? "");
  const named = /(?:^|\.)HttpMethod\.([A-Za-z]+)$/u.exec(text)?.[1] ?? /^new(?:[\w.]*\.)?HttpMethod\("([A-Za-z]+)"\)$/u.exec(text)?.[1];
  const upper = named?.toUpperCase();
  return upper && HTTP_METHODS.has(upper) ? upper : null;
}

const serialized = (template: CSharpStringTemplate | null): string | null => (template ? serializeCSharpString(template) : null);

function argumentNamed(arguments_: readonly ArgumentInfo[], index: number, ...names: string[]): ArgumentInfo | undefined {
  return arguments_.find((argument) => argument.name !== null && names.includes(argument.name)) ?? arguments_.filter((argument) => argument.name === null)[index];
}

// `X.BaseAddress = value` inside the body of a lambda: the value of the first assignment to a lambda parameter's BaseAddress.
function lambdaBase(lambda: SyntaxNode, scope: CSharpStringScope): CSharpStringTemplate | null {
  const names = new Set<string>();
  for (const parameter of lambda.namedChildren) {
    if (parameter.type === "parameter_list") for (const entry of parameter.namedChildren) names.add(entry.childForFieldName("name")?.text ?? entry.namedChildren.at(-1)?.text ?? "");
    else if (parameter.type === "identifier" || parameter.type === "implicit_parameter") names.add(parameter.text);
  }
  const stack: SyntaxNode[] = [lambda];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "assignment_expression" && node.childForFieldName("operator")?.text === "=") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left?.type === "member_access_expression" && left.childForFieldName("name")?.text === "BaseAddress" && names.has(left.childForFieldName("expression")?.text ?? "") && right) return urlOf(right, scope);
    }
    const children = node.namedChildren;
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }
  return null;
}

const enclosingLambdaDeclares = (node: SyntaxNode, name: string): boolean => {
  for (let current = node.parent; current; current = current.parent) {
    if (current.type !== "lambda_expression" && current.type !== "anonymous_method_expression") continue;
    const list = current.namedChildren.find((child) => child.type === "parameter_list");
    const names = list ? list.namedChildren.map((entry) => entry.childForFieldName("name")?.text ?? entry.namedChildren.at(-1)?.text ?? "") : current.namedChildren.filter((child) => child.type === "identifier" || child.type === "implicit_parameter").slice(0, 1).map((child) => child.text);
    if (names.includes(name)) return true;
  }
  return false;
};

// ---------------------------------------------------------------- parse plugin

export const csharpHttpClientsPlugin: VersionedCSharpParsePlugin = Object.assign<VersionedCSharpParsePlugin, { version: string }>(({ root, functions, calls }) => {
  if (!CANDIDATE_FILE.test(root.text)) return;
  const functionOf = (node: SyntaxNode) => {
    let best: (typeof functions)[number] | undefined;
    for (const fn of functions) {
      if (fn.syntax.startIndex <= node.startIndex && node.endIndex <= fn.syntax.endIndex && (!best || fn.syntax.endIndex - fn.syntax.startIndex < best.syntax.endIndex - best.syntax.startIndex)) best = fn;
    }
    return best;
  };
  const scopes = new Map<string, CSharpStringScope>();
  const scopeOf = (fn: (typeof functions)[number] | undefined): CSharpStringScope => {
    if (!fn) return {};
    let scope = scopes.get(fn.node.id);
    if (!scope) {
      scopes.set(fn.node.id, (scope = stringScopeOf(fn)));
      uriLocals.set(scope, readUriLocals(fn.syntax));
    }
    return scope;
  };
  const callBySyntax = new Map<number, CSharpParsedCall>();
  for (const call of calls) callBySyntax.set(call.syntax.id, call);

  // ---- binds: a client or factory result bound to a local or field, the BaseAddress it was given
  const binds = new Map<GraphNode, Bind[]>();
  const addBind = (fn: GraphNode, bind: Bind): void => {
    const list = binds.get(fn) ?? [];
    list.push(bind);
    binds.set(fn, list);
  };
  const targetName = (target: SyntaxNode | null | undefined): string | null => {
    if (!target) return null;
    if (target.type === "identifier") return target.text;
    if (target.type === "member_access_expression" && target.childForFieldName("expression")?.type === "this") {
      const name = target.childForFieldName("name");
      return name?.type === "identifier" ? name.text : null;
    }
    return null;
  };
  const factoryOf = (value: SyntaxNode, scope: CSharpStringScope): { factory: string; name: string | null } | null => {
    if (value.type !== "invocation_expression") return null;
    const info = invocationInfo(value);
    if (!info || info.name !== "CreateClient" || info.typeArguments.length > 0 || !info.receiver) return null;
    const first = info.arguments[0];
    return { factory: written(info.receiver), name: first ? serialized(urlOf(first.node, scope)) : "" };
  };
  const bindValue = (name: string | null, valueNode: SyntaxNode | null, site: SyntaxNode): void => {
    const value = unwrap(valueNode);
    if (!name || !value) return;
    let fn = functionOf(site);
    const scope = scopeOf(fn);
    let base: CSharpStringTemplate | null = null;
    let named: Bind["named"] = null;
    if (isCreation(value)) {
      const type = creationType(value) ?? "HttpClient";
      if (type.split(".").at(-1) !== "HttpClient") return;
      const baseAddress = initializerOf(value).get("BaseAddress");
      if (!baseAddress) return;
      base = urlOf(baseAddress, scope);
      fn ??= functions.find((candidate) => candidate.node.id === callBySyntax.get(value.id)?.function.id);
    } else {
      named = factoryOf(value, scope);
      if (!named) return;
    }
    if (!fn) return;
    addBind(fn.node, { name, local: localNamesOf(fn.node).has(name), base: serialized(base), named });
  };

  const messages: Array<{ call: CSharpParsedCall; syntax: SyntaxNode; name: string | null; fnId: string; method: string | null | undefined; url: CSharpStringTemplate | null; root: string | null; factory?: Raw["factory"] }> = [];
  const messageByVariable = new Map<string, (typeof messages)[number]>();
  const assignedMembers: Array<{ key: string; member: string; value: SyntaxNode; site: SyntaxNode }> = [];

  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.type === "variable_declarator") {
      const [name, value] = node.namedChildren;
      if (name?.type === "identifier" && value && node.namedChildren.length === 2) bindValue(name.text, value, node);
    } else if (node.type === "assignment_expression" && node.childForFieldName("operator")?.text === "=") {
      const left = node.childForFieldName("left");
      const right = node.childForFieldName("right");
      if (left?.type === "member_access_expression" && right) {
        const member = left.childForFieldName("name")?.text ?? "";
        const owner = targetName(left.childForFieldName("expression"));
        if (member === "BaseAddress" && owner && !enclosingLambdaDeclares(node, owner)) {
          const fn = functionOf(node);
          if (fn) addBind(fn.node, { name: owner, local: localNamesOf(fn.node).has(owner), base: serialized(urlOf(right, scopeOf(fn))), named: null });
        } else if ((member === "Method" || member === "RequestUri") && owner) {
          const fn = functionOf(node);
          if (fn) assignedMembers.push({ key: `${fn.node.id}#${owner}`, member, value: right, site: node });
        } else if (targetName(left)) bindValue(targetName(left), right, node);
      } else if (left?.type === "identifier" && right) bindValue(left.text, right, node);
    }
    const children = node.namedChildren;
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index]!);
  }

  // ---- calls
  const record = (call: GraphNode, raw: Raw): void => {
    call.properties[RAW] = JSON.stringify(raw);
  };
  const rootOf = (info: NonNullable<ReturnType<typeof invocationInfo>>, scope: CSharpStringScope): { root: string | null; factory?: Raw["factory"] } => {
    const direct = info.receiver ? factoryOf(unwrap(info.receiver) ?? info.receiver, scope) : null;
    return direct ? { root: null, factory: direct } : { root: info.receiver ? written(info.receiver) : "this" };
  };

  // Messages first (their `new` call), the senders after.
  for (const call of calls) {
    if (!isCreation(call.syntax) || call.node.properties.callee !== "HttpRequestMessage") continue;
    const type = creationType(call.syntax);
    if (type !== null && !MESSAGE_TYPE.test(type)) continue;
    const fn = functions.find((candidate) => candidate.node.id === call.function.id);
    const scope = scopeOf(fn);
    const args = creationArguments(call.syntax);
    const init = initializerOf(call.syntax);
    let method: string | null | undefined;
    let urlNode: SyntaxNode | undefined;
    if (args.length >= 2) {
      method = methodOf(args[0]);
      urlNode = args[1];
    } else if (args.length === 1 && !args[0]!.text.includes("HttpMethod")) urlNode = args[0];
    else if (args.length === 1) method = methodOf(args[0]);
    if (method === undefined && init.has("Method")) method = methodOf(init.get("Method"));
    urlNode ??= init.get("RequestUri");
    const parent = call.syntax.parent;
    let name: string | null = null;
    if (parent?.type === "variable_declarator") name = parent.namedChildren[0]?.text ?? null;
    else if (parent?.type === "assignment_expression") name = targetName(parent.childForFieldName("left"));
    if (name && fn) {
      for (const assigned of assignedMembers) {
        if (assigned.key !== `${fn.node.id}#${name}`) continue;
        if (assigned.member === "Method") method = methodOf(assigned.value);
        else urlNode ??= assigned.value;
      }
    }
    const entry = { call, syntax: call.syntax, name, fnId: call.function.id, method: method === undefined ? "GET" : method, url: urlNode ? urlOf(urlNode, scope) : null, root: null as string | null };
    messages.push(entry);
    if (name) messageByVariable.set(`${call.function.id}#${name}`, entry);
  }

  for (const call of calls) {
    if (call.syntax.type !== "invocation_expression") continue;
    const info = invocationInfo(call.syntax);
    if (!info) continue;
    const fn = functions.find((candidate) => candidate.node.id === call.function.id);
    const scope = scopeOf(fn);

    if (CLIENT_METHODS.has(info.name)) {
      const first = argumentNamed(info.arguments, 0, "requestUri", "uri", "url");
      if (!first) continue;
      record(call.node, { k: "client", method: CLIENT_METHODS.get(info.name)!, url: serialized(urlOf(first.node, scope)), ...rootOf(info, scope) });
    } else if (SEND_METHODS.has(info.name)) {
      const arg = unwrap(info.arguments[0]?.node);
      let message = isCreation(arg) ? messages.find((entry) => entry.syntax.id === arg!.id) : undefined;
      if (!message && arg?.type === "identifier") message = messageByVariable.get(`${call.function.id}#${arg.text}`);
      if (message && message.root === null && message.factory === undefined) {
        const sender = rootOf(info, scope);
        message.root = sender.root;
        if (sender.factory) message.factory = sender.factory;
      }
    } else if (info.name === "For" && info.typeArguments.length === 1 && /(?:^|\.)RestService$/u.test(written(info.receiver))) {
      const arg = unwrap(info.arguments[0]?.node);
      let url: CSharpStringTemplate | null = null;
      let rootName: string | null = null;
      if (arg && isCreation(arg)) {
        const baseAddress = initializerOf(arg).get("BaseAddress");
        url = baseAddress ? urlOf(baseAddress, scope) : null;
      } else if (arg?.type === "identifier" && (arg.text === "client" || arg.text === "http" || /[cC]lient$|^_?http/u.test(arg.text))) rootName = arg.text;
      else if (arg) url = urlOf(arg, scope);
      const parent = call.syntax.parent;
      const bound = parent?.type === "variable_declarator" ? parent.namedChildren[0]?.text ?? null : parent?.type === "assignment_expression" ? targetName(parent.childForFieldName("left")) : null;
      record(call.node, { k: "restFor", method: null, url: serialized(url), root: rootName, target: info.typeArguments[0]!, bound });
    } else if (info.name === "AddHttpClient" || info.name === "AddRefitClient" || info.name === "ConfigureHttpClient") {
      const lambda = info.arguments.find((argument) => argument.kind === "lambda");
      let source = info;
      if (info.name === "ConfigureHttpClient") {
        // `AddHttpClient("x").ConfigureHttpClient(c => ...)`: the registration is the call before.
        let receiver: SyntaxNode | null = unwrap(info.receiver);
        let found: ReturnType<typeof invocationInfo> = null;
        while (receiver?.type === "invocation_expression" && !found) {
          const candidate = invocationInfo(receiver);
          if (!candidate) break;
          if (candidate.name === "AddHttpClient" || candidate.name === "AddRefitClient") found = candidate;
          else receiver = unwrap(candidate.receiver);
        }
        if (!found) continue;
        source = found;
      }
      const kind: Reg["kind"] = source.name === "AddRefitClient" ? "refit" : "http";
      const first = source.arguments[0];
      const name = kind === "http" && first && first.kind !== "lambda" ? serialized(urlOf(first.node, scope)) : null;
      if (kind === "http" && source.arguments.length === 0 && source.typeArguments.length === 0) continue;
      const typeArguments = source.typeArguments;
      const base = lambda ? lambdaBase(lambda.node, scope) : null;
      const reg: Reg = { kind, typeArguments, name, base: serialized(base) };
      call.node.properties[REG] = JSON.stringify(reg);
    }
  }

  for (const message of messages) {
    if ((message.root === null && message.factory === undefined) || !message.url) continue;
    record(message.call.node, { k: "message", method: message.method ?? null, url: serialized(message.url), root: message.root, ...(message.factory ? { factory: message.factory } : {}) });
  }

  for (const [fn, list] of binds) fn.properties[BINDS] = JSON.stringify(list);
}, { version: "2" });

// ---------------------------------------------------------------- contributor

const ABSOLUTE = /^[a-z][a-z0-9+.-]*:\/\//iu;

// The URL without its query string or hash (outside placeholders).
function withoutQuery(url: string): string {
  let depth = 0;
  for (let index = 0; index < url.length; index++) {
    if (url.startsWith("${", index)) depth++;
    else if (url[index] === "}" && depth > 0) depth--;
    else if (depth === 0 && (url[index] === "?" || url[index] === "#")) return url.slice(0, index);
  }
  return url;
}

// `http://user:pw@host/x` is `http://host/x`: credentials never reach the graph.
const withoutUserInfo = (url: string): string => url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/?#]*@/iu, "$1");

// A request URL against the base address, as .NET resolves it (`resolveReference`): `/x` replaces the base's path, `x` is
// relative to the base's last `/`, an absolute URL ignores the base.
// A Refit method's path goes after the base address's path (Refit concatenates them: `For<IApi>("http://h/v3")` with
// `[Get("/users")]` is `/v3/users`), unlike `HttpClient`.
const refitUrl = (base: string, url: string): string => (ABSOLUTE.test(url) ? url : url === "" ? base : `${base.replace(/\/+$/u, "")}/${url.replace(/^\/+/u, "")}`);

function joinUrl(base: string, url: string): string {
  const holes: string[] = [];
  const mask = (text: string): string => text.replace(/\$\{[^}]*\}/gu, (hole) => `${MARK_OPEN}${holes.push(hole) - 1}${MARK_CLOSE}`);
  return resolveReference(mask(base), mask(url)).replace(new RegExp(`${MARK_OPEN}(\\d+)${MARK_CLOSE}`, "gu"), (_all, index: string) => holes[Number(index)]!);
}

function parse<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

const CONFIG_NAME = /(?:^|\.)_?(?:config|configuration|cfg|configurationRoot|appSettings|settings)\w*$/iu;
const CONFIG_STEP = /^(?:\??\[|\.(?:GetSection|GetRequiredSection|GetValue|GetConnectionString)\b|\.Value$)/u;

/**
 * `c["A:B"]`, `c?["A"]`, `c.GetValue<T>("A:B"[, "d"])`, `c.GetConnectionString("X")`, `c.GetSection("A")["B"]`,
 * `c.GetSection("A").GetSection("B").Value`, `c.GetSection("A").GetValue<T>("B")` (compact text): the receiver and the
 * colon key (null when a key is not a string literal or the chain is another shape); null for text that is no such read.
 */
function parseConfigRead(body: string): { receiver: string; key: string | null; fallback: string | null } | null {
  let split = -1;
  for (let index = 1; index < body.length; index += 1) {
    if (/^[\w.?]+$/u.test(body.slice(0, index)) && CONFIG_STEP.test(body.slice(index))) {
      split = index;
      break;
    }
  }
  if (split === -1) return null;
  const receiver = body.slice(0, split);
  let rest = body.slice(split);
  const keys: string[] = [];
  let fallback: string | null = null;
  let connection = false;
  let key: string | null = "";
  for (;;) {
    let match: RegExpExecArray | null;
    if (rest === "") break;
    if ((match = /^\.(?:GetSection|GetRequiredSection)\("([^"]+)"\)/u.exec(rest))) keys.push(match[1]!);
    else if ((match = /^\??\["([^"]+)"\]$/u.exec(rest))) keys.push(match[1]!);
    else if ((match = /^\.GetValue(?:<[\w.?]+>)?\("([^"]+)"(?:,"([^"]*)")?\)$/u.exec(rest))) {
      keys.push(match[1]!);
      fallback = match[2] ?? null;
    } else if ((match = /^\.GetConnectionString\("([^"]+)"\)$/u.exec(rest))) {
      keys.push(match[1]!);
      connection = true;
    } else if (rest === ".Value") {
      rest = "";
      continue;
    } else {
      key = null;
      break;
    }
    rest = rest.slice(match[0].length);
  }
  if (key === null || keys.length === 0 || (connection && keys.length > 1)) return { receiver, key: null, fallback: null };
  return { receiver, key: joinKey(...(connection ? ["ConnectionStrings", ...keys] : keys)), fallback };
}
const CONFIGURATION_TYPES = ["IConfiguration", "IConfigurationRoot", "IConfigurationSection", "ConfigurationManager", "ConfigurationRoot", "ConfigurationSection"];
const FACTORY_TYPES = ["IHttpClientFactory", "HttpClientFactory", "DefaultHttpClientFactory"];

type Method = { name: string; parameterCount: number; httpMethod: string; template: CSharpStringTemplate; node: GraphNode; owner: CSharpType };

export const csharpHttpClientsContributor: ISemanticContributor = {
  id: "csharp.http-clients",
  async contribute(graph, rootPath, _report, files) {
    // The private facts are read and removed first, whatever returns below.
    const raws: Array<{ call: GraphNode; raw: Raw }> = [];
    for (const call of graph.nodesWithLabel("Call")) {
      const raw = parse<Raw>(call.properties[RAW]);
      if (call.properties[RAW] !== undefined) delete call.properties[RAW];
      if (raw) raws.push({ call, raw });
    }
    const regs: Array<{ call: GraphNode; reg: Reg }> = [];
    for (const call of graph.nodesWithLabel("Call")) {
      const reg = parse<Reg>(call.properties[REG]);
      if (call.properties[REG] !== undefined) delete call.properties[REG];
      if (reg) regs.push({ call, reg });
    }
    const bindsOf = new Map<string, Bind[]>();
    for (const fn of graph.nodesWithLabel("Function")) {
      if (fn.properties[BINDS] === undefined) continue;
      const list = parse<Bind[]>(fn.properties[BINDS]);
      delete fn.properties[BINDS];
      if (list) bindsOf.set(fn.id, list);
    }

    const reader = csharpAttributeReader(graph);
    const receivers = createCSharpReceiverResolver(graph);
    const types = receivers.types;
    const refitMethods = new Map<string, Method[]>();
    const ownMethods = new Map<string, GraphNode[]>();
    for (const rel of graph.relationshipsOfType("DEFINES_INTERFACE_METHOD" as GraphRelationship["type"])) {
      const fn = graph.node(rel.to);
      if (fn) ownMethods.set(rel.from, [...ownMethods.get(rel.from) ?? [], fn]);
    }
    const refitInterfaces = new Set<string>();
    for (const [typeId, methods] of ownMethods) {
      if (methods.some((fn) => reader.attributesOf(fn).some((attribute) => [...REFIT_VERBS.keys()].some((verb) => findAttributes([attribute], verb, ["Refit"]).length > 0)))) refitInterfaces.add(typeId);
    }
    if (raws.length === 0 && regs.length === 0 && refitInterfaces.size === 0) return;

    const strings = createCSharpStringResolver(graph);
    const settings = await readAppSettings(rootPath, files ?? []);
    const relationships = createResolutionRelationshipIndex(graph);

    const fileNode = (id: string | undefined): GraphNode | undefined => (id ? graph.node(id) : undefined);
    const isTest = (id: string | undefined): boolean => {
      const file = fileNode(id);
      return file?.properties.isTest === true || file?.properties.sourceType === "test";
    };
    const nearOf = (node: GraphNode): string => String(fileNode(csharpFileOfId(node.id))?.properties.relativePath ?? "").replaceAll("\\", "/");
    const functionOf = (node: GraphNode): GraphNode | undefined => (node.label === "Call" ? receivers.functionOf(node) : node);

    // A configuration read written as an expression: its value in the closest appsettings file; an unknown key keeps its
    // name (`${config:A:B}`), and a read whose key is not literal is `${expr}`: never the written text.
    const configText = (expression: string, node: GraphNode, near: string): CSharpStringPart | null => {
      const compact = expression.replace(/\s+/gu, "");
      let fallback: string | null = null;
      let body = compact;
      const defaulted = /^(.*?)\?\?"([^"]*)"$/u.exec(compact);
      if (defaulted) {
        body = defaulted[1]!;
        fallback = defaulted[2]!;
      }
      body = body.replace(/!$/u, "");
      const read = parseConfigRead(body);
      if (!read) return null;
      const fn = functionOf(node);
      const typed = fn ? receivers.typeOf(read.receiver.replace(/\?$/u, ""), fn) : null;
      if (typed ? !receiverMatches(typed, CONFIGURATION_TYPES, receivers) : !CONFIG_NAME.test(read.receiver)) return null;
      if (read.key === null) return { expr: "expr" };
      fallback ??= read.fallback;
      const entry = isSecretConfigKey(read.key) ? null : settings.lookup(read.key, { near });
      return { text: entry ? entry.value : fallback ?? `\${config:${read.key}}` };
    };
    const render = (template: CSharpStringTemplate, node: GraphNode): string => {
      const near = nearOf(node);
      const parts = strings.resolvePartsAt(template, node).map((part): CSharpStringPart => {
        if ("expr" in part) {
          const value = configText(part.expr, node, near);
          if (value !== null) return value;
          // Written text with quotes, a call or a lambda is no placeholder name.
          if (/["'\\]/u.test(part.expr)) return { expr: "expr" };
        }
        return part;
      });
      return renderCSharpString(parts);
    };
    const literal = (serializedTemplate: string | null, node: GraphNode): string | null => {
      const template = parseCSharpString(serializedTemplate);
      if (!template) return null;
      const resolved = strings.resolvePartsAt(template, node);
      return resolved.every((part) => "text" in part) ? resolved.map((part) => ("text" in part ? part.text : "")).join("") : null;
    };

    // ---- registrations
    const namedBases = new Map<string, string>();
    const typedBases = new Map<string, string>();
    const typedRegistered = new Set<string>();
    const refitBases = new Map<string, string>();
    // `RestService.For<T>(url)` results: `<function or class>#<name>#<interface>` -> base.
    const restForBases = new Map<string, string>();
    const keep = <K>(map: Map<K, string>, key: K, value: string | null): void => {
      if (value !== null && !map.has(key)) map.set(key, value);
    };
    for (const { call, reg } of regs) {
      if (isTest(csharpFileOfId(call.id))) continue;
      const base = reg.base ? render(parseCSharpString(reg.base) ?? [], call) : null;
      const resolve = (written: string | undefined): CSharpType | null => (written ? types.resolve(written, call) : null);
      if (reg.kind === "refit") {
        const type = resolve(reg.typeArguments[0]);
        if (type) keep(refitBases, type.id, base);
        continue;
      }
      const name = reg.name !== null ? literal(reg.name, call) : null;
      if (name !== null) keep(namedBases, name, base);
      else if (reg.name === null && reg.typeArguments.length === 0) keep(namedBases, "", base);
      const type = resolve(reg.typeArguments.at(-1));
      if (type) {
        typedRegistered.add(type.id);
        keep(typedBases, type.id, base);
      }
    }

    // ---- binds by function and by owning class (fields set in any method of the class)
    type Owned = { bind: Bind; fn: GraphNode };
    const fieldBinds = new Map<string, Owned[]>();
    for (const [fnId, list] of bindsOf) {
      const fn = graph.node(fnId);
      const owner = fn ? types.ownerOf(fn) : undefined;
      if (!owner) continue;
      const fields = list.filter((bind) => !bind.local).map((bind): Owned => ({ bind, fn: fn! }));
      if (fields.length > 0) fieldBinds.set(owner.id, [...fieldBinds.get(owner.id) ?? [], ...fields]);
    }

    type Client = { base: string | null; factory: boolean };
    const factoryOk = (text: string, fn: GraphNode): boolean => {
      const typed = receivers.typeOf(text, fn);
      return typed ? receiverMatches(typed, FACTORY_TYPES, receivers) : FACTORY_TYPES.some((name) => text.includes(name));
    };
    const namedClient = (factory: { factory: string; name: string | null }, fn: GraphNode, node: GraphNode): Client | null => {
      if (!factoryOk(factory.factory, fn)) return null;
      const name = factory.name === "" ? "" : literal(factory.name, node);
      if (name === null) return { base: null, factory: true };
      return { base: namedBases.get(name) ?? null, factory: true };
    };
    // The client a receiver is, with its base: null when it is not an HttpClient.
    const clientOf = (rootText: string | null, direct: Raw["factory"], fn: GraphNode, node: GraphNode, typed: CSharpReceiverType | null): Client | null => {
      if (direct) return namedClient(direct, fn, node);
      const name = rootText?.replace(/^this\./u, "") ?? "";
      const isName = /^[\p{L}_][\p{L}\p{N}_]*$/u.test(name);
      const owner = types.ownerOf(fn);
      const local = isName ? (bindsOf.get(fn.id) ?? []).find((candidate) => candidate.name === name && candidate.local) : undefined;
      const field = isName && !local && owner ? (fieldBinds.get(owner.id) ?? []).find((candidate) => candidate.bind.name === name) : undefined;
      const bind = local ?? field?.bind;
      // A factory result is checked and named where it was assigned (the constructor, for a field).
      const site = field?.fn ?? fn;
      if (bind?.named) {
        const client = namedClient(bind.named, site, site);
        if (client) return client;
      }
      if (!receiverMatches(typed, ["HttpClient"], receivers)) return null;
      if (bind?.base) return { base: render(parseCSharpString(bind.base) ?? [], node), factory: false };
      if (owner && typed?.via === "field" && typedRegistered.has(owner.id)) return { base: typedBases.get(owner.id) ?? null, factory: true };
      return { base: null, factory: false };
    };

    const apply = (call: GraphNode, client: string, method: string | null, url: string): void => {
      call.properties.httpClient = client;
      call.properties.httpMethod = method;
      call.properties.httpUrl = withoutUserInfo(withoutQuery(url));
    };

    // ---- `RestService.For<IApi>(...)`: the base of a Refit interface (first, the requests need it)
    for (const { call, raw } of raws) {
      if (raw.k !== "restFor" || !raw.target) continue;
      const fn = functionOf(call);
      if (!fn || isTest(csharpFileOfId(call.id))) continue;
      const type = types.resolve(raw.target, call);
      if (!type) continue;
      let base: string | null = null;
      const template = parseCSharpString(raw.url);
      if (template) base = render(template, call);
      else if (raw.root) {
        const bind = (bindsOf.get(fn.id) ?? []).find((candidate) => candidate.name === raw.root);
        if (bind?.base) base = render(parseCSharpString(bind.base) ?? [], call);
      }
      keep(refitBases, type.id, base);
      // The result's own base, for the calls through the local or field it is assigned to.
      if (base !== null && raw.bound) {
        const scopeId = localNamesOf(fn).has(raw.bound) ? fn.id : types.ownerOf(fn)?.id;
        if (scopeId) restForBases.set(`${scopeId}#${raw.bound}#${type.id}`, base);
      }
    }

    // ---- HttpClient requests
    for (const { call, raw } of raws) {
      if (raw.k === "restFor") continue;
      const fn = functionOf(call);
      if (!fn || isTest(csharpFileOfId(call.id))) continue;
      const template = parseCSharpString(raw.url);
      if (!template) continue;
      const typed = raw.root ? receivers.typeOf(raw.root, fn) : null;
      const client = clientOf(raw.root, raw.factory, fn, call, typed);
      if (!client) continue;
      let url = render(template, call);
      // A URL that starts with an unknown part may be absolute: no base in front of it.
      if (client.base !== null && !url.startsWith("${")) url = joinUrl(client.base, url);
      apply(call, client.factory ? "httpclient-factory" : "httpclient", raw.method, url);
    }

    // ---- Refit
    if (refitInterfaces.size === 0) return;
    const placeholders = (path: string): string => path.replace(/\{\*{0,2}([A-Za-z_]\w*)\}/gu, (_all, name: string) => `\${${name}}`);
    for (const typeId of refitInterfaces) {
      const type = types.index.byId.get(typeId);
      if (!type || isTest(type.fileIds[0])) continue;
      const collected: Method[] = [];
      const seen = new Set<string>();
      const visit = (current: CSharpType): void => {
        if (seen.has(current.id)) return;
        seen.add(current.id);
        for (const fn of ownMethods.get(current.id) ?? []) {
          const attributes = reader.attributesOf(fn);
          for (const [verb, httpMethod] of REFIT_VERBS) {
            const attribute = findAttributes(attributes, verb, ["Refit"])[0];
            if (!attribute) continue;
            const path = attributeValue(positionalArguments(attribute)[0] ?? null);
            const template: CSharpStringTemplate = path ? (path.resolved ? [{ text: path.value }] : csharpStringFromText(path.value) ?? [{ expr: path.value }]) : [];
            collected.push({ name: String(fn.properties.name), parameterCount: jsonList(fn.properties.parameters).length, httpMethod, template, node: fn, owner: current });
            break;
          }
        }
        for (const parent of types.index.supertypes(current)) visit(parent);
      };
      visit(type);
      refitMethods.set(typeId, collected);
    }
    const byResolved = new Map<string, string>();
    for (const rel of graph.relationshipsOfType("CALL_RESOLVES_TO")) byResolved.set(rel.from, rel.to);
    const ownerOfMethod = new Map<string, string>();
    for (const [typeId, methods] of refitMethods) for (const method of methods) if (!ownerOfMethod.has(method.node.id)) ownerOfMethod.set(method.node.id, typeId);
    const wanted = new Set([...refitMethods.values()].flatMap((methods) => methods.map((method) => method.name)));
    for (const call of graph.nodesWithLabel("Call")) {
      if (call.properties.callKind !== "method" || call.properties.httpClient !== undefined || !wanted.has(String(call.properties.callee))) continue;
      const fnId = relationships.callerFunctionByCallId.get(call.id);
      if (isTest(csharpFileOfId(call.id))) continue;
      let owner: string | null = null;
      const typed = receivers.typeOfCall(call);
      if (typed?.type && refitMethods.has(typed.type.id)) owner = typed.type.id;
      const resolved = byResolved.get(call.id);
      if (!owner && resolved) owner = ownerOfMethod.get(resolved) ?? null;
      if (!owner || !fnId) continue;
      const matches = refitMethods.get(owner)!.filter((method) => method.name === String(call.properties.callee));
      const sameCount = matches.filter((method) => method.parameterCount === Number(call.properties.argumentCount ?? -1));
      const chosen = matches.length === 1 ? matches[0] : sameCount.length === 1 ? sameCount[0] : undefined;
      if (!chosen) continue;
      // The base of the receiver's own `RestService.For<T>(url)`, else the registration's (or the first `For`'s).
      const receiver = typeof call.properties.receiver === "string" ? call.properties.receiver.replace(/^this\./u, "") : "";
      const callerFn = graph.node(fnId);
      const ownBase = receiver !== "" && callerFn ? restForBases.get(`${callerFn.id}#${receiver}#${owner}`) ?? restForBases.get(`${types.ownerOf(callerFn)?.id}#${receiver}#${owner}`) : undefined;
      const base = ownBase ?? refitBases.get(owner) ?? null;
      const url = placeholders(render(chosen.template, chosen.node));
      apply(call, "refit", chosen.httpMethod, base !== null && !url.startsWith("${") ? refitUrl(base, url) : url);
    }
  },
};

// Graph schema additions of this track: none (`Call.httpClient`, `httpMethod` and `httpUrl` exist).
export const csharpHttpClientsSchema: GraphSchemaExtension = { id: "csharp-http-clients" };

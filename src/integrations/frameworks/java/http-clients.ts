import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";
import { compactExpression, modifiersOf, annotationOf, normalizeJavaType, typeText, typeDeclarationTypes } from "../../languages/java/syntax.js";
import { createJavaTypeIndex, type JavaType } from "../../languages/java/types.js";
import { annotationEnum, annotationValue, findAnnotations, javaAnnotationReader, joinRoutePath, type JavaAnnotationInfo, type JavaAnnotationReader } from "./annotations.js";
import { readScanConfig, isSecretKey, keyToEnvName, type SpringConfig } from "./config-files.js";
import { createJavaReceiverResolver, receiverMatches } from "./receivers.js";
import { javaMethods, type JavaMethod } from "./shared.js";
import {
  javaStringFromText,
  createJavaStringResolver,
  parseJavaString,
  readJavaString,
  readLocalStrings,
  renderJavaString,
  serializeJavaString,
  type JavaStringScope,
  type JavaStringTemplate,
} from "./strings.js";

// Java outbound HTTP, recorded on the Call node like the JS/TS, Go, Rust and Python clients
// (`httpClient`, `httpMethod`, `httpUrl`), so `js-ts.http-requests` links it to the Route it reaches
// (REQUESTS, with the `--api-origin` rules). Two steps: the parse plugin reads the shape of each
// candidate call (method, URL template, base-URL template) into a private `javaHttp` property; the
// contributor, once every file is parsed, checks the receiver's type (`receivers.ts`), resolves
// constants (`strings.ts`), `@Value("${…}")` fields and Feign annotations through the Spring config
// (`config-files.ts`), writes the three public properties and removes `javaHttp`.
//
//   - RestTemplate (and RestOperations): `getForObject`, `getForEntity`, `postForObject`, `postForEntity`,
//     `postForLocation`, `put`, `patchForObject`, `delete`, `headForHeaders`, `optionsForAllow`,
//     `exchange(url, HttpMethod.X, …)` and `execute(url, HttpMethod.X, …)`, also with
//     `RequestEntity.get(url)…` as first argument. Recorded on the call itself. URI template variables
//     (`/users/{id}`) stay as written and match route parameters. A `new RestTemplateBuilder().rootUri(b)`
//     base counts like a client's base URL.
//   - RestClient and WebClient: `client.get().uri("/x/{id}", id)…`, `.method(HttpMethod.POST)`,
//     `.uri(URI.create(…))` and `.uri(b -> b.path("/x").build())` (the path when it is literal). Recorded on
//     the `uri(...)` call. The base URL is the one of the chain (`RestClient.create(base)`, `.baseUrl(base)`)
//     or of the field / local the receiver names when the same class (or method) built it
//     (`this.client = builder.baseUrl(b).build()`, `WebClient.create(b)`), or, for an injected client, the
//     only `@Bean` method of the scan that builds a client of that type with a base URL. A relative path
//     gets the base in front, like Python's `base_url`.
//   - java.net.http: `HttpRequest.newBuilder(URI.create(url))` / `.uri(...)` with `.GET()`, `.POST(…)`,
//     `.PUT(…)`, `.DELETE()`, `.method("X", …)` and `.build()` (GET when no method is named). Recorded on
//     the `HttpRequest.newBuilder` call: one request per request expression, whatever sends it (`send`,
//     `sendAsync`), and the function that builds the request is the one that requests.
//   - OkHttp: `new Request.Builder().url(url).get()` / `.post(body)` / `.method("X", body)` … `.build()`,
//     recorded on the `new Request.Builder()` call for the same reason (`client.newCall(request)` sends it).
//   - OpenFeign: a `@FeignClient(name | value, url, path)` interface (Spring Cloud OpenFeign), or a plain
//     Feign interface with `@RequestLine("GET /x")` whose base is a `Feign.builder().target(Api.class, url)`,
//     has no Call of its own, so the request is recorded on each Call of the scan that invokes one of its
//     methods (receiver typed as the interface, or `CALL_RESOLVES_TO` its method): its method, and the base
//     URL (`url`, placeholders resolved through the Spring config; without `url` the service name as
//     `http://<name>`, which `--api-origin http://<name>` turns into a path) plus `path` plus the method's
//     mapping (`@GetMapping`, `@PostMapping`, …, `@RequestMapping(method = …)`). `REQUESTS` then runs from
//     the Call, so the function that calls the Feign method requests the route.
//   - Strings: literals, constants, locals and concatenations as in `strings.ts`; a `@Value("${api.url}")`
//     field is the Spring config value (an unresolved placeholder is `${env:NAME}`, `NAME` the key as
//     an environment variable would name it); `env.getProperty("api.url")` likewise; anything else dynamic
//     is `${expression}` and matches a route parameter, or leaves the call unlinked when it starts the URL.
//     A query string or fragment is dropped.
// Test files (`File.isTest`) are skipped.
//
// A client may be a subclass of the library type (`class MyRt extends RestTemplate`, through scanned types
// too): `receiverMatches` follows the supertypes. A file is a candidate when it names a client type or one
// of RestTemplate's distinctive methods (`getForObject`, `postForEntity`, …). `${…}` placeholders are filled
// with the entries of the active profiles (`spring.profiles.active`) first, never through a key named like a
// secret (`${db.password}` stays as written), and the userinfo of an absolute URL (`http://user:pw@host`) is
// dropped from `httpUrl`. `UriComponentsBuilder.path` joins with one slash. A Feign overload is linked only
// when exactly one has the call's argument count.
//
// Not handled: `HttpRequest.Builder` / `Request.Builder` held in a variable (only a chain from `newBuilder` /
// `new Request.Builder()` to `build()` is read), Apache HttpClient, Retrofit, `HttpURLConnection`, Jersey / JAX-RS `Client`,
// `RestTemplate.exchange(RequestEntity)` built elsewhere, `WebClient` requests built through a
// `RequestHeadersUriSpec` variable, URLs built by `UriComponentsBuilder` beyond `path` / `pathSegment`,
// a base URL set by `@Bean` customizers, `uriBuilder` lambdas that do not call `path`, Feign
// `@FeignClient` through meta-annotations, JAX-RS annotations on Feign interfaces, Feign
// `configuration`/`contextId` and Ribbon / load-balancer URL rewriting, `${env:X}` values read from `.env*` files.

type Kind = "template" | "fluent" | "jdk" | "okhttp" | "feignTarget";

type RawRequest = {
  k: Kind;
  method: string | null;
  /** The URL as a template (`serializeJavaString`), null when the call names none. */
  url: string | null;
  /** The text whose type decides whether this is the library: a receiver, or a type name. */
  root: string | null;
  base: string | null;
  /** The receiver named a field or local built here (so its base, possibly none, is known). */
  bound: boolean;
  /** `feignTarget`: the interface written in `target(Api.class, …)`. */
  target?: string;
};

const PROPERTY = "javaHttp";
const BEAN_PROPERTY = "javaHttpBean";

const VERBS = new Map([["get", "GET"], ["post", "POST"], ["put", "PUT"], ["patch", "PATCH"], ["delete", "DELETE"], ["head", "HEAD"], ["options", "OPTIONS"]]);
const TEMPLATE_METHODS = new Map([
  ["getForObject", "GET"], ["getForEntity", "GET"], ["postForObject", "POST"], ["postForEntity", "POST"], ["postForLocation", "POST"],
  ["put", "PUT"], ["patchForObject", "PATCH"], ["delete", "DELETE"], ["headForHeaders", "HEAD"], ["optionsForAllow", "OPTIONS"],
]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE"]);
const JDK_METHODS = new Map([["GET", "GET"], ["POST", "POST"], ["PUT", "PUT"], ["DELETE", "DELETE"]]);
const OKHTTP_METHODS = new Map([["get", "GET"], ["post", "POST"], ["put", "PUT"], ["patch", "PATCH"], ["delete", "DELETE"], ["head", "HEAD"]]);

const TEMPLATE_TYPES = ["org.springframework.web.client.RestTemplate", "org.springframework.web.client.RestOperations"];
const FLUENT_TYPES = [
  "org.springframework.web.client.RestClient", "org.springframework.web.client.RestClient.Builder",
  "org.springframework.web.reactive.function.client.WebClient", "org.springframework.web.reactive.function.client.WebClient.Builder",
];
const JDK_TYPES = ["java.net.http.HttpRequest"];
const OKHTTP_TYPES = ["okhttp3.Request"];
const FEIGN_BUILDER_TYPES = ["feign.Feign"];
const BEAN_TYPES = new Set(["RestClient", "WebClient", "RestTemplate"]);

const FEIGN_PACKAGES = ["org.springframework.cloud.openfeign", "org.springframework.cloud.netflix.feign"];
const SPRING_WEB = ["org.springframework.web.bind.annotation"];
const MAPPINGS = new Map([["GetMapping", "GET"], ["PostMapping", "POST"], ["PutMapping", "PUT"], ["DeleteMapping", "DELETE"], ["PatchMapping", "PATCH"]]);

// ---------------------------------------------------------------- syntax helpers

const isComment = (node: SyntaxNode): boolean => node.type.endsWith("comment");
const argsOf = (call: SyntaxNode): SyntaxNode[] => call.childForFieldName("arguments")?.namedChildren.filter((child) => !isComment(child)) ?? [];
const nameOf = (call: SyntaxNode): string => call.childForFieldName("name")?.text ?? "";
const text = (node: SyntaxNode | null | undefined): string => (node ? compactExpression(node.text) : "");

// The calls of a chain from the outermost down to the innermost, and the expression it starts at.
function chainDown(call: SyntaxNode): { calls: SyntaxNode[]; start: SyntaxNode | null } {
  const calls: SyntaxNode[] = [];
  let current: SyntaxNode | null = call;
  while (current?.type === "method_invocation") {
    calls.push(current);
    current = current.childForFieldName("object");
  }
  return { calls, start: current };
}

// `start` and the calls chained after it, innermost first.
function chainUp(start: SyntaxNode): SyntaxNode[] {
  const calls = [start];
  let current = start;
  for (;;) {
    let parent = current.parent;
    while (parent?.type === "parenthesized_expression") parent = parent.parent;
    if (parent?.type === "method_invocation" && parent.childForFieldName("object")?.id === current.id) {
      calls.push(parent);
      current = parent;
    } else return calls;
  }
}

const URI_TYPE = /^(?:java\.net\.)?(?:URI|URL)$/u;
const URI_BUILDER = /^(?:[\w$]+\.)*UriComponentsBuilder$/u;
const URL_PASS_THROUGH = new Set(["build", "buildAndExpand", "toUri", "toUriString", "toUriComponents", "encode", "expand", "queryParam", "queryParams", "fragment", "replaceQueryParam", "query", "toString", "uriVariables"]);

const concat = (...parts: JavaStringTemplate[]): JavaStringTemplate => parts.flat();

// `UriComponentsBuilder.path`: the slash between two paths is one (`"/a/"` + `"/b"` and `"/a"` + `"b"` are `/a/b`)
// when both sides of the join are literal text; otherwise the parts are put together as they are.
function joinPath(left: JavaStringTemplate, right: JavaStringTemplate): JavaStringTemplate {
  const last = left.at(-1);
  const first = right[0];
  if (!last || !first || !("text" in last) || !("text" in first) || first.text === "") return concat(left, right);
  if (left.length === 0) return right;
  const head = last.text;
  const tail = first.text.replace(/^\/+/u, "");
  return [...left.slice(0, -1), { text: `${head}${head.endsWith("/") ? "" : "/"}${tail}` }, ...right.slice(1)];
}

// The template of a URL argument: a string expression, `URI.create(s)`, `new URI(s)`, `new URL(s)`,
// `HttpUrl.get(s)`, and `UriComponentsBuilder.fromHttpUrl(s).path(p).build().toUri()`.
function urlOf(node: SyntaxNode, scope: JavaStringScope, depth = 0): JavaStringTemplate {
  if (depth < 8) {
    if (node.type === "parenthesized_expression" && node.namedChildren[0]) return urlOf(node.namedChildren[0], scope, depth + 1);
    if (node.type === "object_creation_expression") {
      const type = normalizeJavaType(typeText(node.childForFieldName("type")));
      const first = argsOf(node)[0];
      if (type && URI_TYPE.test(type) && first) return urlOf(first, scope, depth + 1);
    } else if (node.type === "method_invocation") {
      const name = nameOf(node);
      const object = node.childForFieldName("object");
      const objectText = text(object);
      const args = argsOf(node);
      if (args[0] && /^(?:java\.net\.)?URI$/u.test(objectText) && name === "create") return urlOf(args[0], scope, depth + 1);
      if (args[0] && /^(?:[\w$]+\.)*HttpUrl$/u.test(objectText) && (name === "get" || name === "parse")) return urlOf(args[0], scope, depth + 1);
      if (args[0] && URI_BUILDER.test(objectText) && ["fromHttpUrl", "fromUriString", "fromUri", "fromPath"].includes(name)) return urlOf(args[0], scope, depth + 1);
      if (object?.type === "method_invocation" || (object && URI_BUILDER.test(objectText))) {
        const root = object.type === "method_invocation" ? chainDown(object).calls.at(-1) : null;
        const builderChain = root ? URI_BUILDER.test(text(root.childForFieldName("object"))) : false;
        if (builderChain && object.type === "method_invocation") {
          if (name === "path" && args[0]) return joinPath(urlOf(object, scope, depth + 1), urlOf(args[0], scope, depth + 1));
          if (name === "pathSegment") return args.reduce<JavaStringTemplate>((joined, arg) => joinPath(joined, concat([{ text: "/" }], urlOf(arg, scope, depth + 1))), urlOf(object, scope, depth + 1));
          if (URL_PASS_THROUGH.has(name)) return urlOf(object, scope, depth + 1);
        }
      }
    }
  }
  return readJavaString(node, scope) ?? (node.type === "string_literal" && text(node) === '""' ? [] : [{ expr: text(node) }]);
}

// `uri(b -> b.path("/x/{id}").build(id))`: the paths of the `b` chain; dynamic when there is none.
function lambdaPath(lambda: SyntaxNode, scope: JavaStringScope): JavaStringTemplate {
  const parameters = lambda.childForFieldName("parameters");
  const parameter = parameters?.type === "identifier" ? parameters.text : parameters?.namedChildren.find((child) => child.type === "identifier" || child.type === "formal_parameter")?.text.split(/\s+/u).at(-1);
  let body = lambda.childForFieldName("body");
  if (body?.type === "block") {
    const stack: SyntaxNode[] = [body];
    body = null;
    while (stack.length > 0 && !body) {
      const node = stack.pop()!;
      if (node.type === "return_statement") body = node.namedChildren.find((child) => !isComment(child)) ?? null;
      else for (const child of node.namedChildren) stack.push(child);
    }
  }
  if (!body || !parameter) return [{ expr: "uri" }];
  const { calls, start } = chainDown(body);
  if (start?.type !== "identifier" || start.text !== parameter) return [{ expr: "uri" }];
  const paths = calls.reverse().filter((call) => nameOf(call) === "path" || nameOf(call) === "replacePath");
  const first = paths[0];
  if (!first || !argsOf(first)[0]) return [{ expr: "uri" }];
  return concat(...paths.flatMap((call) => (argsOf(call)[0] ? [urlOf(argsOf(call)[0]!, scope)] : [])));
}

// `HttpMethod.POST`, `HttpMethod.valueOf("POST")`, `"POST"`, `RequestMethod.POST`.
function methodOf(node: SyntaxNode | undefined): string | null {
  if (!node) return null;
  const written = text(node);
  const literal = /^"([A-Za-z]+)"$/u.exec(written)?.[1];
  const named = literal ?? /^(?:[\w.]*\.)?(?:HttpMethod|RequestMethod)\.([A-Z]+)$/u.exec(written)?.[1] ?? /^(?:[\w.]*\.)?HttpMethod\.(?:valueOf|resolve)\("([A-Za-z]+)"\)$/u.exec(written)?.[1];
  const upper = named?.toUpperCase();
  return upper && HTTP_METHODS.has(upper) ? upper : null;
}

const METHOD_OWNERS = new Set(["method_declaration", "constructor_declaration", "compact_constructor_declaration"]);

function enclosing(node: SyntaxNode, types: ReadonlySet<string>): SyntaxNode | null {
  for (let current = node.parent; current; current = current.parent) if (types.has(current.type)) return current;
  return null;
}

// The names of the types around a node, innermost first.
function typeNamesAround(node: SyntaxNode): string[] {
  const names: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if (typeDeclarationTypes.has(current.type)) {
      const name = current.childForFieldName("name")?.text;
      if (name) names.push(name);
    }
  }
  return names;
}

// ---------------------------------------------------------------- parse plugin

type Binding = { base: JavaStringTemplate | null };

export const javaHttpClientsPlugin: JavaParsePlugin & { version: string } = Object.assign<JavaParsePlugin, { version: string }>(({ fileNodeId, root, nodes, functions }) => {
  const source = root.text;
  if (!/\b(?:RestTemplate|RestOperations|RestClient|WebClient|HttpRequest|Request\.Builder|Feign|RestTemplateBuilder|getForObject|getForEntity|postForObject|postForEntity|postForLocation|patchForObject|headForHeaders|optionsForAllow)\b/u.test(source)) return;

  const callNodes = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.label === "Call" && node.id.startsWith(`${fileNodeId}:`)) callNodes.set(`${node.properties.line}:${node.properties.columnNumber}:${node.properties.expression}`, node);
  }
  const functionOf = (node: SyntaxNode) => functions.find((fn) => fn.syntax.startIndex <= node.startIndex && node.endIndex <= fn.syntax.endIndex);
  const scopes = new Map<number, JavaStringScope>();
  const scopeOf = (node: SyntaxNode): JavaStringScope => {
    const method = enclosing(node, METHOD_OWNERS);
    if (!method) return {};
    let scope = scopes.get(method.id);
    if (!scope) {
      scope = { locals: readLocalStrings([method]) };
      scopes.set(method.id, scope);
    }
    return scope;
  };
  const callOf = (node: SyntaxNode): GraphNode | undefined => {
    const expression = node.type === "method_invocation"
      ? (node.childForFieldName("object") ? `${text(node.childForFieldName("object"))}.${nameOf(node)}` : nameOf(node))
      : `new ${normalizeJavaType(typeText(node.childForFieldName("type"))) ?? ""}`;
    return callNodes.get(`${node.startPosition.row + 1}:${node.startPosition.column}:${expression}`);
  };

  // Names bound to a client built in this file: `Class.field` and `method#local`, with the base URL they were built with.
  const bindings = new Map<string, Binding>();
  const baseOf = (value: SyntaxNode, scope: JavaStringScope): JavaStringTemplate | null => {
    const { calls, start } = chainDown(value);
    const staticClient = start && /^(?:[\w$]+\.)*(?:WebClient|RestClient)$/u.test(text(start));
    for (const call of calls) {
      const name = nameOf(call);
      const first = argsOf(call)[0];
      if (first && (name === "baseUrl" || name === "rootUri" || (name === "create" && staticClient))) return urlOf(first, scope);
    }
    return null;
  };
  const buildsClient = (value: SyntaxNode | null): value is SyntaxNode => value?.type === "method_invocation" || value?.type === "object_creation_expression";
  const bindName = (target: SyntaxNode | null, value: SyntaxNode | null, site: SyntaxNode, local: boolean): void => {
    if (!target || !buildsClient(value)) return;
    const name = target.type === "field_access" && target.childForFieldName("object")?.text === "this" ? target.childForFieldName("field")?.text : target.type === "identifier" ? target.text : undefined;
    if (!name) return;
    const method = enclosing(site, METHOD_OWNERS);
    const declaredLocally = local || (target.type === "identifier" && method !== null && localNames(method).has(name));
    const key = declaredLocally ? `${method?.id ?? "-"}#${name}` : `${typeNamesAround(site)[0] ?? ""}.${name}`;
    bindings.set(key, { base: baseOf(value, scopeOf(site)) });
  };
  const localNameCache = new Map<number, Set<string>>();
  const localNames = (method: SyntaxNode): Set<string> => {
    let names = localNameCache.get(method.id);
    if (!names) {
      names = new Set();
      const stack: SyntaxNode[] = [method];
      while (stack.length > 0) {
        const node = stack.pop()!;
        if (node.type === "local_variable_declaration") for (const declarator of node.childrenForFieldName("declarator")) names.add(declarator.childForFieldName("name")?.text ?? "");
        for (const child of node.namedChildren) stack.push(child);
      }
      localNameCache.set(method.id, names);
    }
    return names;
  };

  // One walk: bindings, @Bean methods and the candidate calls.
  const candidates: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.type) {
      case "field_declaration":
      case "local_variable_declaration":
        for (const declarator of node.childrenForFieldName("declarator")) bindName(declarator.childForFieldName("name"), declarator.childForFieldName("value"), node, node.type === "local_variable_declaration");
        break;
      case "assignment_expression":
        if (node.childForFieldName("operator")?.text === "=" || !node.childForFieldName("operator")) bindName(node.childForFieldName("left"), node.childForFieldName("right"), node, false);
        break;
      case "method_invocation":
      case "object_creation_expression":
        candidates.push(node);
        break;
      case "method_declaration": {
        const returned = normalizeJavaType(typeText(node.childForFieldName("type")));
        const isBean = modifiersOf(node).annotations.some((annotation) => /^(?:[\w.]+\.)?Bean$/u.test(annotationOf(annotation).name));
        if (isBean && returned && BEAN_TYPES.has(returned.split(".").at(-1)!)) {
          const fn = functions.find((candidate) => candidate.syntax.id === node.id);
          const body = node.childForFieldName("body");
          let value: SyntaxNode | null = null;
          const inner: SyntaxNode[] = body ? [body] : [];
          while (inner.length > 0 && !value) {
            const current = inner.pop()!;
            if (current.type === "return_statement") value = current.namedChildren.find((child) => !isComment(child)) ?? null;
            else if (!typeDeclarationTypes.has(current.type)) for (const child of current.namedChildren) inner.push(child);
          }
          if (fn && value) fn.node.properties[BEAN_PROPERTY] = JSON.stringify({ type: returned, base: (() => { const base = baseOf(value, scopeOf(node)); return base ? serializeJavaString(base) : null; })() });
        }
        break;
      }
      default:
        break;
    }
    for (const child of node.namedChildren) stack.push(child);
  }

  const lookupBinding = (name: string, site: SyntaxNode): Binding | undefined => {
    const method = enclosing(site, METHOD_OWNERS);
    const local = method ? bindings.get(`${method.id}#${name}`) : undefined;
    if (local) return local;
    for (const type of typeNamesAround(site)) {
      const field = bindings.get(`${type}.${name}`);
      if (field) return field;
    }
    return undefined;
  };
  const simpleName = (start: SyntaxNode | null): string | null => (start?.type === "identifier" ? start.text : start?.type === "field_access" && start.childForFieldName("object")?.text === "this" ? start.childForFieldName("field")?.text ?? null : null);

  const record = (call: GraphNode, request: RawRequest): void => {
    call.properties[PROPERTY] = JSON.stringify(request);
  };
  const serialized = (template: JavaStringTemplate | null): string | null => (template ? serializeJavaString(template) : null);

  for (const node of candidates) {
    const call = callOf(node);
    if (!call || !functionOf(node)) continue;
    const scope = scopeOf(node);

    if (node.type === "object_creation_expression") {
      // `new Request.Builder()`: the OkHttp request, read from the chain built on it.
      const type = normalizeJavaType(typeText(node.childForFieldName("type")));
      if (!type || !/(?:^|\.)Request\.Builder$/u.test(type)) continue;
      const chain = chainUp(node);
      if (nameOf(chain.at(-1)!) !== "build") continue;
      let method = "GET";
      let url: JavaStringTemplate | null = null;
      for (const step of chain.slice(1)) {
        const name = nameOf(step);
        if (name === "url" && argsOf(step)[0]) url = urlOf(argsOf(step)[0]!, scope);
        else if (OKHTTP_METHODS.has(name)) method = OKHTTP_METHODS.get(name)!;
        else if (name === "method") method = methodOf(argsOf(step)[0]) ?? "";
      }
      record(call, { k: "okhttp", method: method || null, url: serialized(url), root: type.replace(/\.Builder$/u, ""), base: null, bound: false });
      continue;
    }

    const name = nameOf(node);
    const object = node.childForFieldName("object");
    const args = argsOf(node);
    const objectText = text(object);

    if (name === "newBuilder" && /^(?:[\w$]+\.)*HttpRequest$/u.test(objectText)) {
      const chain = chainUp(node);
      if (nameOf(chain.at(-1)!) !== "build") continue;
      let method = "GET";
      let url: JavaStringTemplate | null = args[0] ? urlOf(args[0], scope) : null;
      for (const step of chain.slice(1)) {
        const stepName = nameOf(step);
        if (stepName === "uri" && argsOf(step)[0]) url = urlOf(argsOf(step)[0]!, scope);
        else if (JDK_METHODS.has(stepName)) method = JDK_METHODS.get(stepName)!;
        else if (stepName === "method") method = methodOf(argsOf(step)[0]) ?? "";
      }
      record(call, { k: "jdk", method: method || null, url: serialized(url), root: objectText, base: null, bound: false });
      continue;
    }

    if (name === "target" && args.length >= 2 && args[0]!.type === "class_literal" && /\bFeign\b/u.test(text(node))) {
      const written = text(args[0]).replace(/\.class$/u, "");
      const { calls } = chainDown(node);
      const feign = calls.at(-1);
      if (!feign || !/(?:^|\.)Feign$/u.test(text(feign.childForFieldName("object")))) continue;
      record(call, { k: "feignTarget", method: null, url: serialized(urlOf(args[1]!, scope)), root: text(feign.childForFieldName("object")), base: null, bound: false, target: written });
      continue;
    }

    if (TEMPLATE_METHODS.has(name) || name === "exchange" || name === "execute") {
      if (!object) continue;
      let method: string | null = TEMPLATE_METHODS.get(name) ?? null;
      let urlNode = args[0];
      if (name === "exchange" || name === "execute") {
        method = methodOf(args[1]);
        // `exchange(RequestEntity.get(url).build(), …)`.
        const entity = args[0] && args[0].type === "method_invocation" ? chainDown(args[0]) : null;
        const entityRoot = entity?.calls.at(-1);
        if (entityRoot && /^(?:[\w$]+\.)*RequestEntity$/u.test(text(entityRoot.childForFieldName("object"))) && VERBS.has(nameOf(entityRoot).toLowerCase()) && argsOf(entityRoot)[0]) {
          method = VERBS.get(nameOf(entityRoot).toLowerCase())!;
          urlNode = argsOf(entityRoot)[0];
        }
      }
      if (!urlNode) continue;
      const bindingName = simpleName(object);
      const binding = bindingName ? lookupBinding(bindingName, node) : undefined;
      record(call, { k: "template", method, url: serialized(urlOf(urlNode, scope)), root: objectText, base: serialized(binding?.base ?? null), bound: binding !== undefined });
      continue;
    }

    if (name === "uri" && object?.type === "method_invocation" && args[0]) {
      const { calls, start } = chainDown(node);
      let method: string | null = null;
      let base: JavaStringTemplate | null = null;
      let seen = false;
      for (const step of calls.slice(1)) {
        const stepName = nameOf(step);
        if (!seen && VERBS.has(stepName) && argsOf(step).length === 0) {
          method = VERBS.get(stepName)!;
          seen = true;
        } else if (!seen && stepName === "method") {
          method = methodOf(argsOf(step)[0]);
          seen = true;
        } else if (stepName === "baseUrl" || (stepName === "create" && argsOf(step)[0] && /^(?:[\w$]+\.)*(?:WebClient|RestClient)$/u.test(text(step.childForFieldName("object"))))) {
          base ??= urlOf(argsOf(step)[0]!, scope);
        }
      }
      if (!seen || !start) continue;
      const bindingName = simpleName(start);
      const binding = bindingName ? lookupBinding(bindingName, node) : undefined;
      const url = args[0].type === "lambda_expression" ? lambdaPath(args[0], scope) : urlOf(args[0], scope);
      record(call, { k: "fluent", method, url: serialized(url), root: text(start), base: serialized(base ?? binding?.base ?? null), bound: base !== null || binding !== undefined });
    }
  }
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

const joinUrl = (base: string, url: string): string => (ABSOLUTE.test(url) ? url : url === "" ? base : `${base.replace(/\/+$/u, "")}/${url.replace(/^\/+/u, "")}`);

const parseRaw = (call: GraphNode): RawRequest | null => {
  try {
    return JSON.parse(String(call.properties[PROPERTY])) as RawRequest;
  } catch {
    return null;
  }
};

export const javaHttpClientsContributor: ISemanticContributor = {
  id: "java.http-clients",
  async contribute(graph, rootPath, _report, files) {
    // The private `@Bean` facts are read and removed first, whatever returns below.
    const beanFacts: Array<{ method: JavaMethod; text: string }> = [];
    for (const method of javaMethods(graph)) {
      const beanText = method.node.properties[BEAN_PROPERTY];
      if (beanText === undefined) continue;
      delete method.node.properties[BEAN_PROPERTY];
      if (typeof beanText === "string") beanFacts.push({ method, text: beanText });
    }
    const raws = graph.nodesWithLabel("Call").filter((node) => node.properties[PROPERTY] !== undefined);
    const interfaces = graph.nodesWithLabel("Interface");
    const reader = javaAnnotationReader(graph);
    const withRequestLine = requestLineOwners(graph, reader);
    const feignInterfaces = interfaces.filter((node) => withRequestLine.has(node.id) || findAnnotations(reader.annotationsOf(node), "FeignClient", FEIGN_PACKAGES).length > 0);
    if (raws.length === 0 && feignInterfaces.length === 0) return;

    const relationships = createResolutionRelationshipIndex(graph);
    const types = createJavaTypeIndex(graph, relationships);
    const receivers = createJavaReceiverResolver(graph);
    const strings = createJavaStringResolver(graph);
    const config: SpringConfig = await readScanConfig(rootPath, files ?? []);
    const methods = new Map(javaMethods(graph).map((method) => [method.node.id, method]));

    const fileNode = (fileId: string) => graph.node(fileId);
    const relativePathOf = (fileId: string): string => String(fileNode(fileId)?.properties.relativePath ?? "").replaceAll("\\", "/");

    // `@Value("${key}")` fields (and constructor parameters named like a field), by type.
    const valueFields = new Map<string, Map<string, string>>();
    for (const rel of graph.relationshipsOfType("DEFINES_FIELD")) {
      const field = graph.node(rel.to);
      if (!field) continue;
      const value = findAnnotations(reader.annotationsOf(field), "Value", ["org.springframework.beans.factory.annotation"])[0];
      const written = value ? annotationValue(value)?.[0] : undefined;
      if (!written?.resolved) continue;
      const own = valueFields.get(rel.from) ?? new Map<string, string>();
      own.set(String(field.properties.name), written.value);
      valueFields.set(rel.from, own);
    }
    for (const { node, owner } of methods.values()) {
      if (node.properties.kind !== "constructor") continue;
      try {
        for (const parameter of JSON.parse(String(node.properties.parameters ?? "[]")) as Array<{ name: string; annotations?: Array<{ name: string; args: string[] }> }>) {
          const annotation = parameter.annotations?.find((entry) => /^(?:[\w.]+\.)?Value$/u.test(entry.name));
          const written = annotation ? annotationValue({ args: annotation.args })?.[0] : undefined;
          if (!written?.resolved) continue;
          const own = valueFields.get(owner.id) ?? new Map<string, string>();
          if (!own.has(parameter.name)) own.set(parameter.name, written.value);
          valueFields.set(owner.id, own);
        }
      } catch {
        // unreadable parameters: no @Value there
      }
    }
    const valueOf = (name: string, typeId: string | null | undefined): string | null => {
      for (let current = typeId ? types.byId.get(typeId) ?? null : null; current; current = types.enclosing(current)) {
        const seen = new Set<string>();
        const visit = (type: JavaType): string | null => {
          if (seen.has(type.id)) return null;
          seen.add(type.id);
          const found = valueFields.get(type.id)?.get(name);
          if (found !== undefined) return found;
          for (const parent of types.supertypes(type)) {
            const inherited = visit(parent);
            if (inherited !== null) return inherited;
          }
          return null;
        };
        const found = visit(current);
        if (found !== null) return found;
      }
      return null;
    };

    // The config text with its placeholders filled; a key no file has becomes `${env:NAME}`.
    const active = config.activeProfiles();
    const lookupOptions = (near: string) => (active.length > 0 ? { near, profile: active } : { near });
    const configText = (raw: string, near: string): string => {
      const { value, unresolved } = config.resolveText(raw, lookupOptions(near));
      return unresolved.reduce((result, key) => result.replaceAll(`\${${key}}`, `\${env:${/^[A-Z][A-Z0-9_]*$/u.test(key) ? key : keyToEnvName(key)}}`), value);
    };

    // A template as text for a use site in `scope`: constants, @Value fields and `env.getProperty(...)`.
    const render = (template: JavaStringTemplate, scope: { fileId: string; typeId: string | null; fnLine: number }): string => {
      const near = relativePathOf(scope.fileId);
      const parts = strings.resolveParts(template, scope).map((part) => {
        if ("ref" in part && /^[A-Za-z_$][\w$]*$/u.test(part.ref)) {
          const value = valueOf(part.ref, scope.typeId);
          if (value !== null) return { text: configText(value, near) };
        } else if ("expr" in part) {
          const property = /^[\w$.]+\.(?:getProperty|getRequiredProperty)\("([^"]+)"(?:,"([^"]*)")?\)$/u.exec(part.expr);
          if (property) {
            // A secret's value is never put in a URL.
            const entry = isSecretKey(property[1]!) ? null : config.lookup(property[1]!, lookupOptions(near));
            return { text: entry ? configText(entry.value, near) : property[2] ?? `\${env:${keyToEnvName(property[1]!)}}` };
          }
        }
        return part;
      });
      return renderJavaString(parts);
    };

    // The only @Bean client with a base URL, by simple type name, for an injected client.
    const beanBases = new Map<string, Array<{ template: JavaStringTemplate; typeId: string; fileId: string; fnLine: number }>>();
    for (const { method, text: beanText } of beanFacts) {
      if (findAnnotations(reader.annotationsOf(method.node), "Bean", ["org.springframework.context.annotation"]).length === 0) continue;
      const bean = JSON.parse(beanText) as { type: string; base: string | null };
      const template = parseJavaString(bean.base);
      if (!template) continue;
      const key = bean.type.split(".").at(-1)!;
      beanBases.set(key, [...beanBases.get(key) ?? [], { template, typeId: method.owner.id, fileId: method.fileId, fnLine: Number(method.node.properties.line) }]);
    }

    const apply = (call: GraphNode, client: string, method: string | null, url: string): void => {
      call.properties.httpClient = client;
      call.properties.httpMethod = method;
      call.properties.httpUrl = withoutUserInfo(withoutQuery(url));
    };

    // ------------------------------------------------ calls with a parsed request
    // `Feign.builder().target(Api.class, url)`: the base URL of a plain Feign interface.
    const targets = new Map<string, string>();
    for (const call of raws) {
      const raw = parseRaw(call);
      delete call.properties[PROPERTY];
      if (!raw) continue;
      const fnId = relationships.callerFunctionByCallId.get(call.id);
      const method = fnId ? methods.get(fnId) : undefined;
      if (!fnId || !method) continue;
      const file = fileNode(method.fileId);
      if (file?.properties.isTest === true || file?.properties.sourceType === "test") continue;
      const fn = method.node;
      const scope = { fileId: method.fileId, typeId: method.owner.id, fnLine: Number(fn.properties.line) };
      const typed = raw.root ? receivers.typeOf(raw.root, fn) : null;

      if (raw.k === "feignTarget") {
        // `Feign.builder().target(Api.class, url)`: kept for the interface below.
        const written = parseJavaString(raw.url);
        if (receiverMatches(typed, FEIGN_BUILDER_TYPES) && raw.target && written) {
          const type = types.resolve(raw.target, scope);
          if (type) targets.set(type.id, render(written, scope));
        }
        continue;
      }
      const wanted = raw.k === "template" ? TEMPLATE_TYPES : raw.k === "fluent" ? FLUENT_TYPES : raw.k === "jdk" ? JDK_TYPES : OKHTTP_TYPES;
      if (!receiverMatches(typed, wanted)) continue;

      let baseTemplate = parseJavaString(raw.base);
      let baseScope = scope;
      // An injected client takes the base of the one @Bean of its type that has one.
      if (!baseTemplate && !raw.bound && raw.k === "fluent" && typed) {
        const beans = beanBases.get(typed.typeName.split(".")[0]!);
        if (beans?.length === 1 && (typed.via === "field" || typed.via === "local")) {
          baseTemplate = beans[0]!.template;
          baseScope = { fileId: beans[0]!.fileId, typeId: beans[0]!.typeId, fnLine: beans[0]!.fnLine };
        }
      }
      const urlTemplate = parseJavaString(raw.url);
      let url = urlTemplate ? render(urlTemplate, scope) : "";
      // A URL that starts with an unknown part may be absolute: no base in front of it.
      if (baseTemplate && !url.startsWith("${")) url = joinUrl(render(baseTemplate, baseScope), url);
      const client = raw.k === "template" ? "resttemplate" : raw.k === "fluent" ? (typed?.qualifiedName?.includes("reactive") || typed?.candidates.some((candidate) => candidate.includes("reactive")) ? "webclient" : "restclient") : raw.k === "jdk" ? "httpclient" : "okhttp";
      apply(call, client, raw.method, url);
    }

    // ------------------------------------------------ OpenFeign
    if (feignInterfaces.length === 0) return;
    type FeignMethod = { name: string; parameterCount: number; httpMethod: string; url: string };
    const feignMethods = new Map<string, FeignMethod[]>();
    const ownMethods = new Map<string, GraphNode[]>();
    for (const rel of graph.relationshipsOfType("DEFINES_INTERFACE_METHOD" as never)) {
      const fn = graph.node(rel.to);
      if (fn) ownMethods.set(rel.from, [...ownMethods.get(rel.from) ?? [], fn]);
    }
    const scopeOfType = (type: JavaType) => ({ fileId: type.fileId, typeId: type.id, fnLine: 0 });
    const annotationText = (value: { value: string; resolved: boolean } | undefined, type: JavaType): string | null => {
      if (!value) return null;
      if (value.resolved) return value.value;
      const template = javaStringFromText(value.value);
      return template ? render(template, scopeOfType(type)) : `\${${value.value.replace(/[{}/\s?#]/gu, "_")}}`;
    };
    const first = (ann: JavaAnnotationInfo | undefined, keys: readonly string[]) => {
      for (const key of keys) {
        const value = ann ? annotationValue(ann, key)?.[0] : undefined;
        if (value) return value;
      }
      return undefined;
    };
    const mappingOf = (list: readonly JavaAnnotationInfo[], type: JavaType): { httpMethod: string; path: string } | null => {
      for (const [annotation, httpMethod] of MAPPINGS) {
        const ann = findAnnotations(list, annotation, SPRING_WEB)[0];
        if (ann) return { httpMethod, path: annotationText(first(ann, ["value", "path"]), type) ?? "" };
      }
      const request = findAnnotations(list, "RequestMapping", SPRING_WEB)[0];
      if (request) {
        const httpMethod = annotationEnum(request, "method")?.[0]?.toUpperCase();
        return { httpMethod: httpMethod && HTTP_METHODS.has(httpMethod) ? httpMethod : "ALL", path: annotationText(first(request, ["value", "path"]), type) ?? "" };
      }
      const line = findAnnotations(list, "RequestLine", ["feign"])[0];
      const written = line ? annotationValue(line)?.[0] : undefined;
      const parsed = written?.resolved ? /^\s*([A-Za-z]+)\s+(\S*)/u.exec(written.value) : null;
      return parsed && HTTP_METHODS.has(parsed[1]!.toUpperCase()) ? { httpMethod: parsed[1]!.toUpperCase(), path: parsed[2]! } : null;
    };

    for (const feign of feignInterfaces) {
      const type = types.byId.get(feign.id);
      if (!type) continue;
      const file = fileNode(type.fileId);
      if (file?.properties.isTest === true || file?.properties.sourceType === "test") continue;
      const own = reader.annotationsOf(feign);
      const client = findAnnotations(own, "FeignClient", FEIGN_PACKAGES)[0];
      const near = relativePathOf(type.fileId);
      let base: string;
      if (client) {
        const urlValue = first(client, ["url"]);
        const written = annotationText(urlValue, type);
        const url = written ? configText(written, near) : null;
        const nameValue = first(client, ["name", "value", "serviceId"]);
        const service = annotationText(nameValue, type);
        const path = annotationText(first(client, ["path"]), type);
        const root = url && url !== "" ? url : service ? `${ABSOLUTE.test(configText(service, near)) ? "" : "http://"}${configText(service, near)}` : "${baseUrl}";
        base = path ? joinUrl(root, configText(path, near)) : root;
      } else {
        const target = targets.get(feign.id);
        base = target ?? "${baseUrl}";
      }
      const prefix = mappingOf(own, type);
      // The interface's own methods and those of its superinterfaces (a shared API interface).
      const collected: FeignMethod[] = [];
      const seen = new Set<string>();
      const visit = (current: JavaType): void => {
        if (seen.has(current.id)) return;
        seen.add(current.id);
        for (const method of ownMethods.get(current.id) ?? []) {
          const mapping = mappingOf(reader.annotationsOf(method), current);
          if (!mapping) continue;
          const path = joinRoutePath(prefix?.path, mapping.path);
          collected.push({ name: String(method.properties.name), parameterCount: Number(method.properties.parameterCount ?? 0), httpMethod: mapping.httpMethod, url: path === "/" ? base : joinUrl(base, path) });
        }
        for (const parent of types.supertypes(current)) visit(parent);
      };
      visit(type);
      feignMethods.set(feign.id, collected);
    }

    const byResolved = new Map<string, GraphNode>();
    for (const rel of graph.relationshipsOfType("CALL_RESOLVES_TO")) byResolved.set(rel.from, graph.node(rel.to) as GraphNode);
    // Method -> the Feign interface that declares it (itself or through a superinterface), once.
    const feignOwnerOfMethod = new Map<string, string>();
    for (const [id, list] of feignMethods) {
      if (list.length === 0) continue;
      const type = types.byId.get(id);
      const seenTypes = new Set<string>([id]);
      const stack: JavaType[] = type ? [type] : [];
      for (let next = stack.pop(); next; next = stack.pop()) {
        for (const declared of ownMethods.get(next.id) ?? []) feignOwnerOfMethod.set(declared.id, id);
        for (const parent of types.supertypes(next)) if (!seenTypes.has(parent.id)) { seenTypes.add(parent.id); stack.push(parent); }
      }
    }
    for (const call of graph.nodesWithLabel("Call")) {
      if (call.properties.callKind !== "method" || call.properties.httpClient !== undefined) continue;
      const fnId = relationships.callerFunctionByCallId.get(call.id);
      const caller = fnId ? methods.get(fnId) : undefined;
      if (!caller) continue;
      const callerFile = fileNode(caller.fileId);
      if (callerFile?.properties.isTest === true || callerFile?.properties.sourceType === "test") continue;
      let owner: string | null = null;
      const receiver = receivers.typeOfCall(call, caller.node);
      if (receiver?.typeId && feignMethods.has(receiver.typeId)) owner = receiver.typeId;
      const resolved = byResolved.get(call.id);
      if (!owner && resolved) owner = feignOwnerOfMethod.get(resolved.id) ?? null;
      if (!owner) continue;
      const callee = String(call.properties.callee);
      const count = Number(call.properties.argumentCount ?? -1);
      const matches = feignMethods.get(owner)!.filter((entry) => entry.name === callee);
      // Overloads: the one with this argument count, when exactly one has it.
      const sameCount = matches.filter((entry) => entry.parameterCount === count);
      const chosen = matches.length === 1 ? matches[0] : sameCount.length === 1 ? sameCount[0] : undefined;
      if (!chosen) continue;
      apply(call, "feign", chosen.httpMethod === "ALL" ? null : chosen.httpMethod, chosen.url);
    }
  },
};

function requestLineOwners(graph: IGraphContributor, reader: JavaAnnotationReader): Set<string> {
  const owners = new Set<string>();
  for (const rel of graph.relationshipsOfType("DEFINES_INTERFACE_METHOD" as never)) {
    const method = graph.node(rel.to);
    if (method && findAnnotations(reader.annotationsOf(method), "RequestLine", ["feign"]).length > 0) owners.add(rel.from);
  }
  return owners;
}

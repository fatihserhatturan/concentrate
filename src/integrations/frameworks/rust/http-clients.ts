import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { rustSplitArguments, type RustParsePlugin, type RustParsedFunction } from "../../languages/rust/parser.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { ENV_VALUE_FILES, readEnvFiles } from "../js-ts/env-files.js";

// Rust outbound HTTP, recorded on the Call node like the JS/TS and Go clients
// (`httpClient`, `httpMethod`, `httpUrl`) so the http-requests contributor
// links it to the Route it reaches (REQUESTS, with the `--api-origin` rules):
//   - reqwest: `reqwest::get(url)` (and `blocking::get`), and `get` / `post` /
//     `put` / `patch` / `delete` / `head` / `request(Method::X, url)` on a
//     `Client` (`Client::new()`, `Client::builder()….build()`, a parameter,
//     local, `static` or `self` / state field of a `reqwest::Client` type;
//     `blocking::Client` and `ClientWithMiddleware` too).
// The method is the function's name or a `Method::X` argument (null
// otherwise). The URL is a string literal, a `const` / `static` or local one,
// `format!` (a `{}` over a known string is substituted, any other becomes
// `${expression}`), `String::from`, `.to_string()`, `Url::parse` and `+`
// concatenation; an `std::env::var("X")` / `env!("X")` part is `${env:X}`,
// which the contributor below resolves from the nearest `.env*` file when
// that gives a URL or path. What stays dynamic matches a route parameter, or
// leaves the call unlinked when it starts the URL.

const METHODS = new Map([["get", "GET"], ["post", "POST"], ["put", "PUT"], ["patch", "PATCH"], ["delete", "DELETE"], ["head", "HEAD"]]);
const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"]);
const PASS_THROUGH = new Set(["to_string", "to_owned", "clone", "as_str", "into", "unwrap", "expect", "unwrap_or", "unwrap_or_else", "unwrap_or_default", "as_ref", "borrow"]);
const MAX_DEPTH = 6;

export const rustHttpClientsPlugin: RustParsePlugin = ({ fileNodeId, root, nodes, relationships, functions }) => {
  const source = root.text;
  if (!/\breqwest\b/u.test(source)) return;
  const bareClient = /\buse\s+reqwest::(?:\{[^}]*\bClient\b|Client\b|blocking::Client\b|blocking::\{[^}]*\bClient\b)/u.test(source);
  const bareGet = /\buse\s+reqwest::(?:\{[^}]*\bget\b|get\b)/u.test(source);

  const constants = new Map<string, string>();
  const statics = new Map<string, SyntaxNode>();
  for (const item of root.descendantsOfType("const_item").concat(root.descendantsOfType("static_item"))) {
    const name = item.childForFieldName("name")?.text;
    const value = item.childForFieldName("value");
    if (!name) continue;
    statics.set(name, item);
    const literal = value ? stringLiteral(value) : null;
    if (literal !== null) constants.set(name, literal);
  }
  const structs = new Map<string, Map<string, string>>();
  for (const item of root.descendantsOfType("struct_item")) {
    const name = item.childForFieldName("name")?.text;
    const body = item.childForFieldName("body");
    if (!name || body?.type !== "field_declaration_list") continue;
    const fields = new Map<string, string>();
    for (const field of body.namedChildren) {
      const fieldName = field.childForFieldName("name")?.text;
      const type = field.childForFieldName("type")?.text;
      if (fieldName && type) fields.set(fieldName, type);
    }
    structs.set(name, fields);
  }

  const isClientType = (type: string) => /\breqwest::(?:blocking::)?Client\b|\bClientWithMiddleware\b/u.test(type) || (bareClient && /(?:^|[^\w:])(?:blocking::)?Client\b/u.test(type));
  const functionAround = (node: SyntaxNode): RustParsedFunction | undefined => functions
    .filter((fn) => fn.syntax.startIndex <= node.startIndex && node.endIndex <= fn.syntax.endIndex)
    .sort((left, right) => (left.syntax.endIndex - left.syntax.startIndex) - (right.syntax.endIndex - right.syntax.startIndex))[0];

  // The binding a name stands for in a function: its let (type and value) or
  // parameter (type).
  const bindingOf = (name: string, fn: RustParsedFunction | undefined, before: number): { type?: string; value?: SyntaxNode } | undefined => {
    if (fn) {
      let found: { type?: string; value?: SyntaxNode } | undefined;
      for (const declaration of fn.syntax.descendantsOfType("let_declaration")) {
        if (declaration.startIndex >= before) continue;
        const pattern = declaration.childForFieldName("pattern");
        const bound = pattern?.type === "identifier" ? pattern.text : pattern?.namedChildren.find((child) => child.type === "identifier")?.text;
        if (bound !== name) continue;
        found = { type: declaration.childForFieldName("type")?.text, value: declaration.childForFieldName("value") ?? undefined };
      }
      if (found) return found;
      for (const parameter of fn.syntax.childForFieldName("parameters")?.namedChildren ?? []) {
        if (parameter.type !== "parameter") continue;
        const pattern = parameter.childForFieldName("pattern");
        const names = pattern ? [pattern, ...pattern.descendantsOfType("identifier")].filter((node) => node.type === "identifier").map((node) => node.text) : [];
        if (names.includes(name)) return { type: parameter.childForFieldName("type")?.text };
      }
    }
    const item = statics.get(name);
    return item ? { type: item.childForFieldName("type")?.text, value: item.childForFieldName("value") ?? undefined } : undefined;
  };
  // `AppState` of `&AppState`, `State<AppState>`, `Arc<AppState>`, …
  const structOfType = (type: string | undefined): string | undefined => {
    for (const match of (type ?? "").matchAll(/\b([A-Z]\w*)\b/gu)) if (structs.has(match[1]!)) return match[1];
    return undefined;
  };

  const isClient = (expression: SyntaxNode, fn: RustParsedFunction | undefined, depth: number): boolean => {
    if (depth > MAX_DEPTH) return false;
    switch (expression.type) {
      case "reference_expression":
      case "parenthesized_expression":
      case "try_expression":
      case "await_expression": {
        const inner = expression.childForFieldName("value") ?? expression.namedChildren[0];
        return inner ? isClient(inner, fn, depth + 1) : false;
      }
      case "identifier": {
        const binding = bindingOf(expression.text, fn, expression.startIndex);
        if (!binding) return false;
        if (binding.type && isClientType(binding.type)) return true;
        return binding.value ? isClient(binding.value, fn, depth + 1) : false;
      }
      case "field_expression": {
        const value = expression.childForFieldName("value");
        const field = expression.childForFieldName("field")?.text;
        if (!value || !field) return false;
        let owner: string | undefined;
        if (value.type === "self") owner = fn?.ownerType ?? undefined;
        else if (value.type === "identifier") owner = structOfType(bindingOf(value.text, fn, value.startIndex)?.type);
        else if (value.type === "field_expression") {
          const outer = value.childForFieldName("value");
          const outerField = value.childForFieldName("field")?.text;
          const outerOwner = outer?.type === "self" ? fn?.ownerType ?? undefined : outer?.type === "identifier" ? structOfType(bindingOf(outer.text, fn, outer.startIndex)?.type) : undefined;
          owner = outerOwner && outerField ? structOfType(structs.get(outerOwner)?.get(outerField)) : undefined;
        }
        const type = owner ? structs.get(owner)?.get(field) : undefined;
        return type !== undefined && isClientType(type);
      }
      case "call_expression": {
        const callee = expression.childForFieldName("function");
        const text = (callee?.text ?? "").replace(/\s+/gu, "");
        if (/^(?:reqwest::)?(?:blocking::)?Client::(?:new|builder|default)$/u.test(text) && (text.startsWith("reqwest::") || bareClient)) return true;
        // `Client::builder().timeout(…).build()?`: the chain's own start.
        if (callee?.type === "field_expression") {
          const value = callee.childForFieldName("value");
          const method = callee.childForFieldName("field")?.text ?? "";
          if ((method === "build" || method === "clone" || method === "unwrap" || method === "expect" || /^(?:timeout|user_agent|default_headers|pool_\w+|connect_timeout|danger_\w+|redirect|cookie_store|gzip|brotli|proxy|no_proxy|http1_only|http2_\w+|tls_\w+|use_\w+|build)$/u.test(method)) && value) return isClient(value, fn, depth + 1);
        }
        return false;
      }
      default:
        return false;
    }
  };

  // A URL expression as the written URL: literals and `format!` substituted,
  // anything else `${expression}`.
  const urlText = (node: SyntaxNode, fn: RustParsedFunction | undefined, depth: number): string => {
    if (depth > MAX_DEPTH) return placeholder(node.text);
    const literal = stringLiteral(node);
    if (literal !== null) return literal;
    switch (node.type) {
      case "reference_expression":
      case "parenthesized_expression":
      case "try_expression":
      case "await_expression": {
        const inner = node.childForFieldName("value") ?? node.namedChildren[0];
        return inner ? urlText(inner, fn, depth + 1) : placeholder(node.text);
      }
      case "identifier": {
        const constant = constants.get(node.text);
        if (constant !== undefined) return constant;
        const value = bindingOf(node.text, fn, node.startIndex)?.value;
        return value ? urlText(value, fn, depth + 1) : placeholder(node.text);
      }
      case "scoped_identifier": {
        const constant = constants.get(node.text.replace(/^(?:\w+::)*/u, ""));
        return constant ?? placeholder(node.text);
      }
      case "binary_expression": {
        const left = node.childForFieldName("left");
        const right = node.childForFieldName("right");
        if (node.childForFieldName("operator")?.text === "+" && left && right) return urlText(left, fn, depth + 1) + urlText(right, fn, depth + 1);
        return placeholder(node.text);
      }
      case "macro_invocation": {
        const name = (node.childForFieldName("macro")?.text ?? "").replace(/\s+/gu, "");
        const tokens = node.namedChildren.find((child) => child.type === "token_tree");
        if (/^(?:std::)?(?:option_)?env$/u.test(name)) {
          const variable = tokens?.namedChildren.map(stringLiteral).find((value) => value !== null);
          return variable ? `\${env:${variable}}` : placeholder(node.text);
        }
        if (name === "format" && tokens) return formatText(tokens, fn, depth);
        return placeholder(node.text);
      }
      case "call_expression": {
        const callee = node.childForFieldName("function");
        const calleeText = (callee?.text ?? "").replace(/\s+/gu, "");
        const args = node.childForFieldName("arguments")?.namedChildren ?? [];
        if (/^(?:std::)?env::var(?:_os)?$|^dotenvy?::var$/u.test(calleeText)) {
          const variable = args[0] ? stringLiteral(args[0]) : null;
          return variable ? `\${env:${variable}}` : placeholder(node.text);
        }
        if (/^(?:String::from|Url::parse|reqwest::Url::parse|Cow::Borrowed|Path::new)$/u.test(calleeText) && args[0]) return urlText(args[0], fn, depth + 1);
        if (callee?.type === "field_expression") {
          const method = callee.childForFieldName("field")?.text ?? "";
          const value = callee.childForFieldName("value");
          if (PASS_THROUGH.has(method) && value) return urlText(value, fn, depth + 1);
          if ((method === "join" || method === "push_str") && value && args[0]) return `${urlText(value, fn, depth + 1).replace(/\/+$/u, "")}/${urlText(args[0], fn, depth + 1).replace(/^\/+/u, "")}`;
        }
        return placeholder(node.text);
      }
      default:
        return placeholder(node.text);
    }
  };

  // `format!("{}/users/{id}", base)`.
  const formatText = (tokens: SyntaxNode, fn: RustParsedFunction | undefined, depth: number): string => {
    const template = tokens.namedChildren.map(stringLiteral).find((value) => value !== null);
    if (template === undefined || template === null) return placeholder(tokens.text);
    const parts = rustSplitArguments(tokens.text.slice(1, -1));
    const args = parts.slice(1);
    const named = new Map<string, string>();
    const positional: string[] = [];
    for (const arg of args) {
      const match = /^(\w+)\s*=\s*(.+)$/su.exec(arg);
      if (match) named.set(match[1]!, match[2]!);
      else positional.push(arg);
    }
    const expressionText = (text: string): string => {
      const literal = /^&?("(?:[^"\\]|\\.)*"|r#*".*"#*)$/su.exec(text.trim());
      if (literal) return stringLiteralText(literal[1]!) ?? placeholder(text);
      const name = text.trim().replace(/^&/u, "");
      if (/^\w+$/u.test(name)) {
        const constant = constants.get(name);
        if (constant !== undefined) return constant;
        const value = bindingOf(name, fn, tokens.startIndex)?.value;
        if (value) {
          const resolved = urlText(value, fn, depth + 1);
          return resolved.startsWith("${") && resolved === placeholder(value.text) ? placeholder(name) : resolved;
        }
        return placeholder(name);
      }
      const env = /^(?:std::)?env::var\(\s*"(\w+)"\s*\)(?:\s*\.\s*(?:unwrap|expect)\b.*)?$/su.exec(name);
      return env ? `\${env:${env[1]}}` : placeholder(name);
    };
    let counter = 0;
    return template.replace(/\{\{|\}\}|\{([^{}:]*)(?::[^{}]*)?\}/gu, (written, key: string | undefined) => {
      if (written === "{{") return "{";
      if (written === "}}") return "}";
      const name = (key ?? "").trim();
      if (name === "") return expressionText(positional[counter++] ?? "");
      if (/^\d+$/u.test(name)) return expressionText(positional[Number(name)] ?? "");
      return expressionText(named.get(name) ?? name);
    });
  };

  const callNodes = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.label === "Call" && node.id.startsWith(`${fileNodeId}:`)) callNodes.set(`${node.properties.line}:${node.properties.columnNumber}`, node);
  }

  for (const call of root.descendantsOfType("call_expression")) {
    let callee = call.childForFieldName("function");
    if (callee?.type === "generic_function") callee = callee.childForFieldName("function") ?? callee;
    if (!callee) continue;
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    const fn = functionAround(call);
    let method: string | null = null;
    let url: SyntaxNode | undefined;
    let position = call.startPosition;
    const text = callee.text.replace(/\s+/gu, "");
    if (callee.type === "field_expression") {
      const name = callee.childForFieldName("field")?.text ?? "";
      const value = callee.childForFieldName("value");
      const isRequest = name === "request";
      if (!value || (!METHODS.has(name) && !isRequest)) continue;
      if (!isClient(value, fn, 0)) continue;
      if (isRequest) {
        const written = args[0]?.text.replace(/\s+/gu, "").split("::").pop() ?? "";
        method = HTTP_METHODS.has(written) ? written : null;
        url = args[1];
      } else {
        method = METHODS.get(name)!;
        url = args[0];
      }
      position = (callee.childForFieldName("field") ?? call).startPosition;
    } else if (/^reqwest::(?:blocking::)?get$/u.test(text) || (bareGet && text === "get")) {
      method = "GET";
      url = args[0];
    } else {
      continue;
    }
    if (!url) continue;
    const written = withoutQuery(urlText(url, fn, 0));
    let node = callNodes.get(`${position.row + 1}:${position.column}`);
    if (!node && fn) {
      // A chain on a call (`Client::new().get(url)`) has no Call node yet.
      const expression = text.length > 120 ? `${text.slice(0, 117)}...` : text;
      node = {
        id: `${fn.node.id}:call:${position.row + 1}:${position.column}:${expression}`,
        label: "Call",
        properties: { name: expression, expression, callee: text.split(/[.:]/u).pop() ?? text, receiver: null, line: position.row + 1, columnNumber: position.column },
      };
      nodes.push(node);
      callNodes.set(`${position.row + 1}:${position.column}`, node);
      relationships.push({ from: fn.node.id, to: node.id, type: "CALLS", properties: {} });
    }
    if (!node) continue;
    node.properties.httpClient = "reqwest";
    node.properties.httpMethod = method;
    node.properties.httpUrl = written;
  }
};

// Resolves the `${env:X}` parts of Rust request URLs from the nearest `.env*`
// file (only a URL or path value). Runs before the http-requests contributor.
export const rustHttpClientsContributor: ISemanticContributor = {
  async contribute(graph, rootPath, _report, files) {
    const calls = graph.nodes.filter((node) => node.label === "Call" && node.properties.httpClient === "reqwest" && typeof node.properties.httpUrl === "string" && node.properties.httpUrl.includes("${env:"));
    if (calls.length === 0) return;
    const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const env = await readEnvFiles(rootPath, files);
    const envValue = (name: string, fileId: string): string | undefined => {
      let directory = path.posix.dirname(String(nodeById.get(fileId)?.properties.relativePath ?? "").replaceAll("\\", "/"));
      for (;;) {
        const byName = env.get(directory === "." ? "" : directory);
        for (const file of ENV_VALUE_FILES) {
          const value = byName?.get(file)?.get(name);
          if (value !== undefined) return value;
        }
        if (directory === "." || directory === "") return undefined;
        directory = path.posix.dirname(directory);
      }
    };
    for (const call of calls) {
      const functionId = relationshipIndex.callerFunctionByCallId.get(call.id);
      const fileId = relationshipIndex.callerFileByModuleCallId.get(call.id) ?? (functionId ? relationshipIndex.fileByFunctionId.get(functionId) : undefined);
      if (!fileId) continue;
      call.properties.httpUrl = String(call.properties.httpUrl).replace(/\$\{env:(\w+)\}/gu, (written, name: string) => {
        const value = envValue(name, fileId);
        return value !== undefined && /^(?:https?:\/\/|\/)/u.test(value) ? value : written;
      });
    }
  },
};

// `${expression}`; characters that would split the URL are replaced.
function placeholder(expression: string): string {
  return `\${${expression.replace(/[{}/\s?#]/gu, "_")}}`;
}

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

function stringLiteralText(text: string): string | null {
  const plain = /^"((?:[^"\\]|\\.)*)"$/su.exec(text);
  if (plain) return plain[1]!.replace(/\\\n\s*/gu, "").replace(/\\"/gu, "\"").replace(/\\\\/gu, "\\");
  const raw = /^r(#*)"(.*)"\1$/su.exec(text);
  return raw ? raw[2]! : null;
}

function stringLiteral(node: SyntaxNode): string | null {
  return node.type === "string_literal" || node.type === "raw_string_literal" ? stringLiteralText(node.text) : null;
}

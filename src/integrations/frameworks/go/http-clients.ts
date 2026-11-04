import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GoParsePlugin } from "../../languages/go/parser.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createGoCallIndex } from "../../../core/scan/resolution/go-calls.js";
import { ENV_VALUE_FILES, readEnvFiles } from "../js-ts/env-files.js";
import { importedPackages } from "./routes.js";
import { createDefinitionLookup, stringConstants, valueTypeText, type Definition } from "./scope.js";

// Go outbound HTTP, recorded on the Call node like the JS/TS clients
// (`httpClient`, `httpMethod`, `httpUrl`) so the http-requests contributor
// links it to the Route it reaches (REQUESTS):
//   - net/http: `http.Get(url)`, `http.Head`, `http.Post`, `http.PostForm`;
//     `http.NewRequest(method, url, body)` and `NewRequestWithContext` (the
//     call that builds the request; `client.Do(req)` sends it); `Get` /
//     `Head` / `Post` / `PostForm` on an `*http.Client` (`http.DefaultClient`,
//     a value written `&http.Client{…}`, a parameter, variable or struct
//     field of that type).
//   - resty: `client.R()…Get(url)` / `.Post` / … / `.Execute(method, url)` on
//     a `*resty.Client` (`resty.New()`, typed values and fields) or a
//     `*resty.Request`; `SetBaseURL` / `SetHostURL` on the client is joined
//     to a relative URL.
// The method is the function's name, or a literal / `http.MethodX` argument
// (null otherwise). The URL is a string literal, a local string constant or
// variable, `+` concatenation, `fmt.Sprintf` (each verb becomes a dynamic
// segment) or `path.Join`; any other part is written `${expression}`, which
// the contributor below resolves when it names a package string constant or
// variable (`${baseURL}`, `${api.Prefix}`) or an `os.Getenv("X")` whose
// value an `.env*` file gives as a URL or path. What stays dynamic matches a
// route parameter, or leaves the call unlinked when it starts the URL.

const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const NET_HTTP = "net/http";
const RESTY_PACKAGES = ["github.com/go-resty/resty/v2", "github.com/go-resty/resty", "gopkg.in/resty.v1", "resty.dev/v3"];
const httpFunctions = new Map([["Get", "GET"], ["Head", "HEAD"], ["Post", "POST"], ["PostForm", "POST"]]);
const restyMethods = new Map([["Get", "GET"], ["Head", "HEAD"], ["Post", "POST"], ["Put", "PUT"], ["Patch", "PATCH"], ["Delete", "DELETE"], ["Options", "OPTIONS"]]);
const MAX_DEPTH = 6;

type Resty = { kind: "client" | "request"; base: string | null };

export const goHttpClientsPlugin: GoParsePlugin = ({ fileNodeId, root, nodes }) => {
  const imports = importedPackages(root);
  const http = imports.get(NET_HTTP);
  const resty = RESTY_PACKAGES.map((source) => imports.get(source)).find((alias) => alias !== undefined);
  const fmt = imports.get("fmt");
  const pathAlias = imports.get("path");
  const aliases = new Set(imports.values());
  const constants = stringConstants(root);
  const definitionOf = createDefinitionLookup(root);
  const calls = new Map<string, GraphNode>();
  for (const node of nodes) {
    if (node.label === "Call" && node.id.startsWith(`${fileNodeId}:`)) calls.set(`${node.properties.line}:${node.properties.columnNumber}:${node.properties.expression}`, node);
  }

  // Struct fields by struct name, and the values fields are given
  // (`Client{api: resty.New()…}`, `c.api = …`).
  const fieldTypes = new Map<string, Map<string, string>>();
  for (const spec of root.descendantsOfType("type_spec")) {
    const type = spec.childForFieldName("type");
    const name = spec.childForFieldName("name")?.text;
    if (type?.type !== "struct_type" || !name) continue;
    const fields = new Map<string, string>();
    for (const declaration of type.descendantsOfType("field_declaration")) {
      const fieldType = declaration.childForFieldName("type")?.text;
      for (const field of declaration.childrenForFieldName("name")) if (fieldType) fields.set(field.text, fieldType);
    }
    fieldTypes.set(name, fields);
  }
  const fieldValues = new Map<string, SyntaxNode[]>();
  const addFieldValue = (field: string, value: SyntaxNode | null | undefined) => {
    if (value) fieldValues.set(field, [...fieldValues.get(field) ?? [], value]);
  };
  for (const element of root.descendantsOfType("keyed_element")) {
    const [key, value] = element.namedChildren;
    const name = key?.type === "literal_element" ? key.namedChildren[0] : key;
    if (name?.type === "identifier" || name?.type === "field_identifier") addFieldValue(name.text, value?.type === "literal_element" ? value.namedChildren[0] : value);
  }
  for (const assignment of root.descendantsOfType("assignment_statement")) {
    const left = assignment.childForFieldName("left")?.namedChildren ?? [];
    const right = assignment.childForFieldName("right")?.namedChildren ?? [];
    left.forEach((target, index) => {
      if (target.type === "selector_expression" && right.length === left.length) addFieldValue(target.childForFieldName("field")!.text, right[index]);
    });
  }

  const isType = (type: string | undefined, alias: string | undefined, name: string) => !!alias && type?.replace(/^\*/u, "") === `${alias}.${name}`;

  // The type of a value: as written (`&http.Client{}`), declared, or of a
  // struct field.
  const typeOf = (expression: SyntaxNode, depth: number): string | undefined => {
    if (depth > MAX_DEPTH) return undefined;
    if (expression.type === "parenthesized_expression" && expression.namedChildren[0]) return typeOf(expression.namedChildren[0], depth + 1);
    const written = valueTypeText(expression);
    if (written) return written;
    if (expression.type === "identifier") {
      const definition = definitionOf(expression.text, expression);
      return !definition ? undefined : "type" in definition ? definition.type : typeOf(definition.value, depth + 1);
    }
    if (expression.type === "selector_expression") {
      const operand = expression.childForFieldName("operand")!;
      const field = expression.childForFieldName("field")!.text;
      if (operand.type === "identifier" && aliases.has(operand.text) && !definitionOf(operand.text, operand)) {
        return operand.text === http && field === "DefaultClient" ? `*${http}.Client` : undefined;
      }
      const owner = typeOf(operand, depth + 1)?.replace(/^\*/u, "");
      return owner ? fieldTypes.get(owner)?.get(field) : undefined;
    }
    return undefined;
  };

  const restyOf = (expression: SyntaxNode, depth: number): Resty | null => {
    if (!resty || depth > MAX_DEPTH) return null;
    if (expression.type === "parenthesized_expression" && expression.namedChildren[0]) return restyOf(expression.namedChildren[0], depth + 1);
    if (expression.type === "call_expression") {
      const fn = expression.childForFieldName("function");
      if (fn?.type !== "selector_expression") return null;
      const operand = fn.childForFieldName("operand")!;
      const method = fn.childForFieldName("field")!.text;
      if (operand.type === "identifier" && operand.text === resty && !definitionOf(operand.text, operand)) {
        return method.startsWith("New") ? { kind: "client", base: null } : null;
      }
      if (restyMethods.has(method) || method === "Execute" || method === "Send") return null;
      const inner = restyOf(operand, depth + 1);
      if (!inner) return null;
      if (inner.kind === "client" && (method === "R" || method === "NewRequest")) return { kind: "request", base: inner.base };
      if (inner.kind === "client" && (method === "SetBaseURL" || method === "SetHostURL")) {
        const first = expression.childForFieldName("arguments")?.namedChildren[0];
        return { kind: "client", base: first ? urlText(first, depth + 1) : null };
      }
      return inner;
    }
    const kindOf = (type: string | undefined): Resty["kind"] | null => isType(type, resty, "Client") ? "client" : isType(type, resty, "Request") ? "request" : null;
    if (expression.type === "identifier") {
      const definition = definitionOf(expression.text, expression);
      if (!definition) return null;
      if ("type" in definition) {
        const kind = kindOf(definition.type);
        return kind ? { kind, base: null } : null;
      }
      return restyOf(definition.value, depth + 1);
    }
    if (expression.type === "selector_expression") {
      const kind = kindOf(typeOf(expression, depth + 1));
      if (!kind) return null;
      const field = expression.childForFieldName("field")!.text;
      const bases = new Set((fieldValues.get(field) ?? []).map((value) => restyOf(value, depth + 1)?.base ?? null));
      return { kind, base: bases.size === 1 ? [...bases][0]! : null };
    }
    return null;
  };

  // A URL as written: literal parts kept, anything else as `${expression}`.
  const urlText = (node: SyntaxNode, depth: number): string => {
    if (depth > MAX_DEPTH) return placeholder(node.text);
    if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") return node.text.slice(1, -1);
    if (node.type === "parenthesized_expression" && node.namedChildren[0]) return urlText(node.namedChildren[0], depth + 1);
    if (node.type === "binary_expression" && node.childForFieldName("operator")?.text === "+") {
      return urlText(node.childForFieldName("left")!, depth + 1) + urlText(node.childForFieldName("right")!, depth + 1);
    }
    if (node.type === "identifier") {
      const constant = constants.get(node.text);
      if (constant !== undefined) return constant;
      const definition = definitionOf(node.text, node);
      // A local string the function assigns once before the call.
      if (definition && "value" in definition && !isPackageVariable(node.text, definition)) return urlText(definition.value, depth + 1);
      return placeholder(node.text);
    }
    if (node.type === "call_expression") {
      const fn = node.childForFieldName("function");
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      const operand = fn?.type === "selector_expression" ? fn.childForFieldName("operand") : null;
      const name = fn?.type === "selector_expression" ? fn.childForFieldName("field")!.text : null;
      if (operand?.type === "identifier" && operand.text === fmt && name === "Sprintf" && args[0]) {
        const format = args[0].type === "interpreted_string_literal" || args[0].type === "raw_string_literal" ? args[0].text.slice(1, -1) : null;
        if (format !== null) {
          let next = 1;
          return format.replace(/%(?:%|[-+# 0]*\d*(?:\.\d+)?[a-zA-Z])/gu, (verb) => {
            if (verb === "%%") return "%";
            const arg = args[next++];
            return arg ? (verb.endsWith("s") || verb.endsWith("v") ? urlText(arg, depth + 1) : placeholder(arg.text)) : verb;
          });
        }
      }
      if (operand?.type === "identifier" && operand.text === pathAlias && name === "Join" && args.length > 0) {
        return path.posix.join(...args.map((arg) => urlText(arg, depth + 1)));
      }
    }
    return placeholder(node.text);
  };

  // A name assigned at package level is resolved after the scan (it may be
  // assigned in another file of the package).
  const isPackageVariable = (name: string, definition: Definition) => {
    if (!definition || !("value" in definition)) return false;
    for (let node: SyntaxNode | null = definition.value.parent; node; node = node.parent) {
      if (node.type === "function_declaration" || node.type === "method_declaration" || node.type === "func_literal") return false;
    }
    return name.length > 0;
  };

  // `"POST"`, `http.MethodPost`, a string constant.
  const methodOf = (node: SyntaxNode | undefined): string | null => {
    if (!node) return null;
    const constant = /^(\w+)\.Method(\w+)$/u.exec(node.text);
    const written = node.type === "interpreted_string_literal" || node.type === "raw_string_literal"
      ? node.text.slice(1, -1)
      : node.type === "identifier"
        ? constants.get(node.text)
        : constant && (constant[1] === http || constant[1] === resty) ? constant[2] : undefined;
    const method = written?.toUpperCase();
    return method && methods.has(method) ? method : null;
  };

  // Package strings built from other strings (`var usersPath = Prefix +
  // "/users"`), as templates the contributor resolves.
  const variables = new Map(nodes.filter((node) => node.label === "Variable" && node.id.startsWith(`${fileNodeId}:`)).map((node) => [`${node.properties.line}:${node.properties.name}`, node]));
  for (const spec of root.descendantsOfType(["const_spec", "var_spec"])) {
    if (spec.parent?.parent?.type !== "source_file" && spec.parent?.parent?.parent?.type !== "source_file") continue;
    const values = spec.childForFieldName("value")?.namedChildren ?? [];
    spec.childrenForFieldName("name").forEach((name, index) => {
      const value = values[index];
      if (value?.type !== "binary_expression" && value?.type !== "call_expression") return;
      const template = urlText(value, 0);
      const variable = variables.get(`${name.startPosition.row + 1}:${name.text}`);
      if (variable && variable.properties.stringValue === undefined && template !== placeholder(value.text)) variable.properties.goStringTemplate = template;
    });
  }
  if (!http && !resty) return;

  for (const call of root.descendantsOfType("call_expression")) {
    const fn = call.childForFieldName("function");
    if (fn?.type !== "selector_expression") continue;
    const operand = fn.childForFieldName("operand")!;
    const name = fn.childForFieldName("field")!.text;
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    let request: { client: string; method: string | null; url: string | null; base?: string | null } | null = null;
    const packageCall = operand.type === "identifier" && !definitionOf(operand.text, operand);
    if (http && packageCall && operand.text === http) {
      if (httpFunctions.has(name)) request = { client: NET_HTTP, method: httpFunctions.get(name)!, url: args[0] ? urlText(args[0], 0) : null };
      else if (name === "NewRequest" || name === "NewRequestWithContext") {
        const offset = name === "NewRequest" ? 0 : 1;
        request = { client: NET_HTTP, method: methodOf(args[offset]), url: args[offset + 1] ? urlText(args[offset + 1]!, 0) : null };
      }
    } else if (http && httpFunctions.has(name) && isType(typeOf(operand, 0), http, "Client")) {
      request = { client: NET_HTTP, method: httpFunctions.get(name)!, url: args[0] ? urlText(args[0], 0) : null };
    } else if (resty && (restyMethods.has(name) || name === "Execute")) {
      const target = restyOf(operand, 0);
      if (target?.kind === "request") {
        const [method, url] = name === "Execute" ? [methodOf(args[0]), args[1]] : [restyMethods.get(name)!, args[0]];
        request = { client: "resty", method, url: url ? urlText(url, 0) : null, base: target.base };
      }
    }
    if (!request) continue;
    const node = calls.get(`${call.startPosition.row + 1}:${call.startPosition.column}:${fn.text}`);
    if (!node) continue;
    node.properties.httpClient = request.client;
    node.properties.httpMethod = request.method;
    node.properties.httpUrl = request.url === null ? null : withoutQuery(request.url);
    // The client's base URL, joined once both are resolved.
    if (request.base) node.properties.goHttpBase = request.base;
  }
};

// `${expression}`; characters that would split the URL are replaced.
function placeholder(expression: string): string {
  return `\${${expression.replace(/[{}/\s?#]/gu, "_")}}`;
}

function joinBase(base: string | null, url: string): string {
  if (base === null || /^[a-z][a-z\d+.-]*:\/\//iu.test(url)) return url;
  if (url === "") return base;
  return `${base.replace(/\/+$/u, "")}/${url.replace(/^\/+/u, "")}`;
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

// Resolves the `${…}` parts of Go request URLs the parse could not: package
// string constants and variables (any file of the package, or an imported
// package's exported one) and `os.Getenv("X")` from the nearest `.env*` file
// (only a URL or path value). Runs before the http-requests contributor.
export const goHttpClientsContributor: ISemanticContributor = {
  async contribute(graph, rootPath, _report, files) {
    const templates = new Map<string, string>();
    for (const node of graph.nodes) {
      if (node.label === "Variable" && typeof node.properties.goStringTemplate === "string") {
        templates.set(node.id, node.properties.goStringTemplate);
        delete node.properties.goStringTemplate;
      }
    }
    const calls = graph.nodes.filter((node) => node.label === "Call" && (node.properties.goHttpBase !== undefined || (typeof node.properties.httpUrl === "string" && node.properties.httpUrl.includes("${"))));
    if (calls.length === 0) return;
    const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
    const index = createGoCallIndex(graph, relationshipIndex);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const strings = new Map<string, Map<string, string>>();
    for (const rel of graph.relationships) {
      const variable = rel.type === "DEFINES_VARIABLE" ? nodeById.get(rel.to) : undefined;
      const pkg = index.packageByFile.get(rel.from);
      const value = variable?.label === "Variable" ? variable.properties.stringValue ?? templates.get(variable.id) : undefined;
      if (pkg === undefined || typeof value !== "string") continue;
      const byName = strings.get(pkg) ?? new Map<string, string>();
      byName.set(String(variable!.properties.name), value);
      strings.set(pkg, byName);
    }
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
      const callerFunctionId = relationshipIndex.callerFunctionByCallId.get(call.id);
      const fileId = relationshipIndex.callerFileByModuleCallId.get(call.id) ?? (callerFunctionId ? relationshipIndex.fileByFunctionId.get(callerFunctionId) : undefined);
      const pkg = fileId ? index.packageByFile.get(fileId) : undefined;
      const base = call.properties.goHttpBase;
      delete call.properties.goHttpBase;
      if (!fileId || pkg === undefined || typeof call.properties.httpUrl !== "string") continue;
      const resolve = (text: string, depth: number): string => text.replace(/\$\{([^{}]*)\}/gu, (written, expression: string) => {
        const qualified = /^(?:(\w+)\.)?(\w+)$/u.exec(expression);
        if (qualified) {
          const [, qualifier, name] = qualified;
          const packages = qualifier ? index.importsByFile.get(fileId)?.get(qualifier) ?? [] : [pkg];
          for (const candidate of packages) {
            const value = strings.get(candidate)?.get(name!);
            if (value !== undefined && (!qualifier || /^[A-Z]/u.test(name!))) return depth < 5 ? resolve(value, depth + 1) : value;
          }
          return written;
        }
        const read = /^(\w+)\.Getenv\("(\w+)"\)$/u.exec(expression);
        const value = read ? envValue(read[2]!, fileId) : undefined;
        return value !== undefined && /^(?:https?:\/\/|\/)/u.test(value) ? value : written;
      });
      const url = resolve(String(call.properties.httpUrl), 0);
      call.properties.httpUrl = typeof base === "string" ? joinBase(resolve(base, 0), url) : url;
    }
  },
};

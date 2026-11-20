import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";

// Shared, pure helpers for the Java framework contributors (Spring, JAX-RS, Micronaut, gRPC,
// picocli): reading annotations from the graph, reading their arguments, joining route paths and
// creating Route and EntryPoint nodes the one way every language does.

// ---------------------------------------------------------------- reading annotations

export type JavaAnnotationInfo = {
  /** As written: `GetMapping` or `org.springframework.web.bind.annotation.GetMapping`. */
  name: string;
  /** Without any package prefix: `GetMapping`. */
  simpleName: string;
  /** Known only when written qualified or named by a single-type import; null otherwise (never guessed). */
  qualifiedName: string | null;
  /** Arguments as the parser keeps them: `"a"`, `value="a"`, `path={"a","b"}`, `method=RequestMethod.GET`. */
  args: string[];
  line: number;
  /** Id of the Decorator node. */
  decoratorId: string;
};

const ANNOTATION_RELATIONS: GraphRelationship["type"][] = [
  "HAS_DECORATOR",
  // INTERFACE_HAS_DECORATOR, FIELD_HAS_DECORATOR and HAS_METHOD_DECORATOR: Interface, Field, Function owners.
  "INTERFACE_HAS_DECORATOR" as GraphRelationship["type"],
  "HAS_METHOD_DECORATOR",
  "FIELD_HAS_DECORATOR" as GraphRelationship["type"],
];

export type JavaAnnotationReader = {
  /** Annotations of a Class, Interface, Function (method or constructor) or Field node, in source order. */
  annotationsOf(node: GraphNode | string): JavaAnnotationInfo[];
};

function simpleNameOf(name: string): string {
  return name.slice(name.lastIndexOf(".") + 1);
}

/**
 * Indexes the graph's Java annotations once; call `annotationsOf` per node. Qualified names come from
 * the declaring file's imports: a single-type import (`import a.b.GetMapping;`) of the simple name
 * qualifies it, a name written with its package is its own qualification, and anything else
 * (wildcard imports, same package, java.lang) stays null.
 */
export function javaAnnotationReader(graph: IGraphContributor): JavaAnnotationReader {
  const decoratorsByOwner = new Map<string, GraphNode[]>();
  for (const type of ANNOTATION_RELATIONS) {
    for (const rel of graph.relationshipsOfType(type)) {
      const decorator = graph.node(rel.to);
      if (!decorator) continue;
      const list = decoratorsByOwner.get(rel.from);
      if (list) list.push(decorator);
      else decoratorsByOwner.set(rel.from, [decorator]);
    }
  }
  // Each type's file, each member's owner: members reach their file through the owner.
  const parentOf = new Map<string, string>();
  for (const type of ["DEFINES_CLASS", "DEFINES_INTERFACE", "DEFINES_METHOD", "DEFINES_INTERFACE_METHOD", "DEFINES_FIELD"]) {
    for (const rel of graph.relationshipsOfType(type as GraphRelationship["type"])) parentOf.set(rel.to, rel.from);
  }
  const importsByFile = new Map<string, Map<string, string>>();
  for (const rel of graph.relationshipsOfType("IMPORTS")) {
    const properties = graph.node(rel.to)?.properties;
    if (!properties || properties.isWildcard === true || properties.isStatic === true || typeof properties.source !== "string") continue;
    let imports = importsByFile.get(rel.from);
    if (!imports) importsByFile.set(rel.from, (imports = new Map()));
    imports.set(simpleNameOf(properties.source), properties.source);
  }
  const fileOf = (id: string): string | null => {
    let current = id;
    for (let depth = 0; depth < 32; depth += 1) {
      const parent = parentOf.get(current);
      if (!parent) return null;
      if (graph.node(parent)?.label === "File") return parent;
      current = parent;
    }
    return null;
  };
  return {
    annotationsOf(node) {
      const id = typeof node === "string" ? node : node.id;
      const decorators = decoratorsByOwner.get(id) ?? [];
      if (decorators.length === 0) return [];
      const fileId = fileOf(id);
      return decorators
        .map((decorator): JavaAnnotationInfo => {
          const properties = decorator.properties;
          const name = String(properties.name);
          const simpleName = simpleNameOf(name);
          const qualifiedName = name.includes(".") ? name : fileId ? importsByFile.get(fileId)?.get(simpleName) ?? null : null;
          let args: string[] = [];
          try {
            const parsed: unknown = JSON.parse(String(properties.args ?? "[]"));
            if (Array.isArray(parsed)) args = parsed.map(String);
          } catch {
            // Unreadable arguments count as none.
          }
          return { name, simpleName, qualifiedName, args, line: Number(properties.line), decoratorId: decorator.id };
        })
        .sort((a, b) => a.line - b.line);
    },
  };
}

/**
 * The annotation(s) named `simpleName`. With `packagePrefixes`, an annotation whose qualified name is
 * known must start with one of them (`org.springframework.web.bind.annotation` accepts
 * `org.springframework.web.bind.annotation.GetMapping`); one whose package is unknown still counts.
 */
export function findAnnotations(list: readonly JavaAnnotationInfo[], simpleName: string, packagePrefixes?: readonly string[]): JavaAnnotationInfo[] {
  return list.filter((ann) => {
    if (ann.simpleName !== simpleName) return false;
    if (!packagePrefixes || packagePrefixes.length === 0 || ann.qualifiedName === null) return true;
    const qualified = ann.qualifiedName;
    return packagePrefixes.some((prefix) => qualified === prefix || qualified.startsWith(prefix.endsWith(".") ? prefix : `${prefix}.`));
  });
}

export function hasAnnotation(list: readonly JavaAnnotationInfo[], simpleName: string, packagePrefixes?: readonly string[]): boolean {
  return findAnnotations(list, simpleName, packagePrefixes).length > 0;
}

// ---------------------------------------------------------------- reading arguments

/** One argument value: `resolved` is false for anything but string literals (a constant, a call, a concatenation with a non-literal), `value` then being the expression as written. */
export type AnnotationValue = { value: string; resolved: boolean };

// Splits at `separator` outside strings, braces and parentheses.
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === "\\") i += 1;
      else if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function unescapeJava(body: string): string {
  return body.replace(/\\(u+[0-9a-fA-F]{4}|[btnfr"'\\]|[0-7]{1,3})/gu, (_, code: string) => {
    if (code.startsWith("u")) return String.fromCharCode(parseInt(code.replace(/^u+/u, ""), 16));
    if (/^[0-7]+$/u.test(code)) return String.fromCharCode(parseInt(code, 8));
    return ({ b: "\b", t: "\t", n: "\n", f: "\f", r: "\r" } as Record<string, string>)[code] ?? code;
  });
}

// `"a"` or `"a"+"b"` (literals only) is the string; anything else null.
function literalString(expression: string): string | null {
  let result = "";
  for (const part of splitTopLevel(expression, "+")) {
    if (!/^"(?:[^"\\\n]|\\.)*"$/u.test(part) || part.startsWith('"""')) return null;
    result += unescapeJava(part.slice(1, -1));
  }
  return result;
}

const KEYED = /^([A-Za-z_$][\w$]*)=(.*)$/su;

// The raw expression of an argument: `key=expr`, or for `value` the lone positional one.
function argumentExpression(ann: Pick<JavaAnnotationInfo, "args">, key: string): string | null {
  for (const arg of ann.args) {
    const match = KEYED.exec(arg);
    if (match && match[1] === key) return match[2]!;
  }
  // `@X("a")` and `@X({"a","b"})`: the parser keeps no key for the positional value.
  if (key === "value" && ann.args.length === 1 && !KEYED.test(ann.args[0]!)) return ann.args[0]!;
  return null;
}

// `{a, b}` is two elements, anything else one.
function elementsOf(expression: string): string[] {
  const trimmed = expression.trim();
  return trimmed.startsWith("{") && trimmed.endsWith("}") ? splitTopLevel(trimmed.slice(1, -1), ",").filter((part) => part !== "") : [trimmed];
}

/**
 * The strings of `@X("a")`, `@X(value = "a")`, `@X(path = {"a", "b"})`, `@X({"a", "b"})`; null when the
 * argument is absent. A literal (or literals joined by `+`) is resolved; a constant, call or other
 * expression is returned as written with `resolved: false`, never guessed.
 */
export function annotationValue(ann: Pick<JavaAnnotationInfo, "args">, key = "value"): AnnotationValue[] | null {
  const expression = argumentExpression(ann, key);
  if (expression === null) return null;
  return elementsOf(expression).map((element) => {
    const literal = literalString(element);
    return literal === null ? { value: element, resolved: false } : { value: literal, resolved: true };
  });
}

/**
 * Enum constants of `method = RequestMethod.GET` or `method = {GET, RequestMethod.POST}` as simple names
 * (`["GET", "POST"]`); null when the argument is absent. An element that is no plain (qualified) name,
 * such as a call, is left out.
 */
export function annotationEnum(ann: Pick<JavaAnnotationInfo, "args">, key: string): string[] | null {
  const expression = argumentExpression(ann, key);
  if (expression === null) return null;
  return elementsOf(expression)
    .filter((element) => /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/u.test(element))
    .map(simpleNameOf);
}

// ---------------------------------------------------------------- paths

/**
 * Joins a class path and a method path: `/api` + `users/{id}` is `/api/users/{id}`. Empty, undefined,
 * `""` and `/` parts add nothing; slashes are added or collapsed, trailing slashes dropped; the result
 * always starts with `/` (`/` when nothing is left).
 */
export function joinRoutePath(...parts: ReadonlyArray<string | null | undefined>): string {
  const segments: string[] = [];
  for (const part of parts) {
    for (const segment of (part ?? "").split("/")) if (segment !== "") segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

// ---------------------------------------------------------------- Route and EntryPoint nodes

function uniqueId(graph: IGraphContributor, base: string): string {
  let id = base;
  for (let n = 2; graph.node(id); n += 1) id = `${base}#${n}`;
  return id;
}

export type JavaRouteInput = {
  fileId: string;
  /** Upper case HTTP method (`GET`); `ALL` for any. */
  method: string;
  /** The full, joined path; null when only an expression is known (then give `pathExpression`). */
  path: string | null;
  pathExpression?: string | null;
  /** Shown by `list_routes` `framework`: `spring-mvc`, `spring-webflux`, `jaxrs`, `micronaut`. */
  framework: string;
  line: number;
  /** The handler Function node (a ROUTE_HANDLED_BY edge is made); its name becomes `handlerName`. */
  handler?: GraphNode | null;
  /** The handler's name when no node is known. */
  handlerName?: string | null;
};

/**
 * Adds a Route like the other languages: Route properties as in the graph schema (`path` and
 * `fullPath` both the joined path), `File -DECLARES_ROUTE-> Route` and
 * `Route -ROUTE_HANDLED_BY-> Function`. Returns the node.
 */
export function addJavaRoute(graph: IGraphContributor, input: JavaRouteInput): GraphNode {
  const handlerName = input.handler ? String(input.handler.properties.name) : input.handlerName ?? null;
  const node: GraphNode = {
    id: uniqueId(graph, `${input.fileId}:route:${input.line}:0:${input.method}:${input.path ?? input.pathExpression ?? "<none>"}`),
    label: "Route",
    properties: {
      method: input.method,
      path: input.path,
      fullPath: input.path,
      pathExpression: input.path === null ? input.pathExpression ?? null : null,
      receiverName: null,
      line: input.line,
      framework: input.framework,
      handlerName,
    },
  };
  graph.addNode(node);
  graph.addRelationship({ from: input.fileId, to: node.id, type: "DECLARES_ROUTE", properties: {} });
  if (input.handler) graph.addRelationship({ from: node.id, to: input.handler.id, type: "ROUTE_HANDLED_BY", properties: {} });
  return node;
}

export type JavaEntryPointInput = {
  fileId: string;
  /** `main`, `job`, `grpc`, `command`, ... */
  kind: string;
  /** What triggers it (a cron expression, a service name, a command name); null when nothing does. */
  trigger?: string | null;
  line: number;
  handler: GraphNode;
  /** Library label; `java` (default) for the JVM's own `main`. */
  library?: string;
};

/**
 * Adds an EntryPoint as `javaEntrypointsContributor` does: properties kind, trigger, receiverName
 * (null), library (default `java`), line, handlerName; `File -DECLARES_ENTRYPOINT-> EntryPoint` and
 * `EntryPoint -ENTRYPOINT_HANDLED_BY-> Function`. Returns the node.
 */
export function addJavaEntryPoint(graph: IGraphContributor, input: JavaEntryPointInput): GraphNode {
  const trigger = input.trigger ?? null;
  const node: GraphNode = {
    id: uniqueId(graph, `${input.fileId}:entrypoint:${input.line}:0:${input.kind}:${trigger ?? "<none>"}`),
    label: "EntryPoint",
    properties: {
      kind: input.kind,
      trigger,
      receiverName: null,
      library: input.library ?? "java",
      line: input.line,
      handlerName: String(input.handler.properties.name),
    },
  };
  graph.addNode(node);
  graph.addRelationship({ from: input.fileId, to: node.id, type: "DECLARES_ENTRYPOINT", properties: {} });
  graph.addRelationship({ from: node.id, to: input.handler.id, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
  return node;
}

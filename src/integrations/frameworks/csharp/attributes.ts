import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { usingsInScope } from "../../languages/csharp/namespaces.js";
import { createCSharpTypeIndex } from "../../languages/csharp/types.js";
import { csharpFileOfId } from "./shared.js";

// Shared, pure helpers for the C# framework contributors (ASP.NET Core, gRPC, SignalR, hosted services, Azure
// Functions, System.CommandLine, DI): reading attributes from the graph with the namespace-precision rule (the
// same spirit as Java's annotations.ts) and reading their arguments.

// ---------------------------------------------------------------- reading attributes

export type CSharpAttributeInfo = {
  /** As written: `HttpGet`, `HttpGetAttribute` or `Microsoft.AspNetCore.Mvc.HttpGet` (`global::` removed). */
  name: string;
  /** Last segment without the `Attribute` suffix: `HttpGet`. */
  simpleName: string;
  /**
   * Known when written with a dotted name (as written, never guessed further; `findAttributes` also tries it
   * under each `using`), or when the name resolves to a type the scan declares (then its qualified name: the
   * user's own attribute, which no framework prefix matches). Null otherwise.
   */
  qualifiedName: string | null;
  /** True when a type the scan declares (`Name` or `NameAttribute`) is what the name means at the use site. */
  ownType: boolean;
  /** Arguments as the parser keeps them: `"a"`, `Name="a"`, `typeof(X)`, `Order=1`. Named ones are `key=expr`. */
  args: string[];
  /** `assembly`, `return`, `method`, `param`, `field`, `property`... when written as `[return: X]`; else null. */
  target: string | null;
  line: number;
  /** Id of the Decorator node. */
  decoratorId: string;
  /** Namespaces (and external namespace names) the use site's `using`s and enclosing namespaces bring in, in lookup order. */
  usingNamespaces: readonly string[];
};

const ATTRIBUTE_RELATIONS = ["HAS_DECORATOR", "INTERFACE_HAS_DECORATOR", "HAS_METHOD_DECORATOR", "FIELD_HAS_DECORATOR"] as const;

export type CSharpAttributeReader = {
  /** Attributes of a Class, Interface, Function (method, constructor, accessor) or Field node, in source order. */
  attributesOf(node: GraphNode | string): CSharpAttributeInfo[];
};

const stripSuffix = (name: string): string => (name.endsWith("Attribute") && name.length > "Attribute".length ? name.slice(0, -"Attribute".length) : name);

/**
 * Indexes the graph's C# attributes once; call `attributesOf` per node. Each attribute is read at its own use site:
 * the file comes from the Decorator id, the namespace from the owner type, the line from the attribute (so a `using`
 * written inside a namespace block counts only there).
 */
export function csharpAttributeReader(graph: IGraphContributor): CSharpAttributeReader {
  const decoratorsByOwner = new Map<string, GraphNode[]>();
  for (const type of ATTRIBUTE_RELATIONS) {
    for (const rel of graph.relationshipsOfType(type as GraphRelationship["type"])) {
      const decorator = graph.node(rel.to);
      if (!decorator) continue;
      const list = decoratorsByOwner.get(rel.from);
      if (list) list.push(decorator);
      else decoratorsByOwner.set(rel.from, [decorator]);
    }
  }
  const parentOf = new Map<string, string>();
  for (const type of ["DEFINES_METHOD", "DEFINES_INTERFACE_METHOD", "DEFINES_FIELD", "DEFINES_INTERFACE_FIELD"]) {
    for (const rel of graph.relationshipsOfType(type as GraphRelationship["type"])) parentOf.set(rel.to, rel.from);
  }
  let typeIndex: ReturnType<typeof createCSharpTypeIndex> | undefined;
  const types = () => (typeIndex ??= createCSharpTypeIndex(graph, createResolutionRelationshipIndex(graph)));
  const namespaceOf = (id: string): { namespace: string; typeId: string | null } => {
    const node = graph.node(id);
    if (node && (node.label === "Class" || node.label === "Interface")) return { namespace: String(node.properties.namespace ?? ""), typeId: node.id };
    const parent = parentOf.get(id);
    const owner = parent ? graph.node(parent) : undefined;
    return { namespace: String(owner?.properties.namespace ?? node?.properties.namespace ?? ""), typeId: owner?.id ?? null };
  };
  return {
    attributesOf(node) {
      const id = typeof node === "string" ? node : node.id;
      const decorators = decoratorsByOwner.get(id) ?? [];
      if (decorators.length === 0) return [];
      const { namespace, typeId } = namespaceOf(id);
      return decorators
        .map((decorator): CSharpAttributeInfo => {
          const properties = decorator.properties;
          const name = String(properties.name).replace(/^global::/u, "");
          const line = Number(properties.line);
          const fileId = csharpFileOfId(decorator.id);
          const dotted = name.includes(".");
          const scope = fileId ? { fileId, typeId, namespace, line } : undefined;
          const own = scope ? types().resolve(name, scope) ?? types().resolve(`${name}Attribute`, scope) : null;
          let args: string[] = [];
          try {
            const parsed: unknown = JSON.parse(String(properties.args ?? "[]"));
            if (Array.isArray(parsed)) args = parsed.map(String);
          } catch {
            // Unreadable arguments count as none.
          }
          return {
            name,
            simpleName: stripSuffix(name.slice(name.lastIndexOf(".") + 1)),
            qualifiedName: own ? own.qualifiedName : dotted ? name : null,
            ownType: own !== null,
            args,
            target: typeof properties.attributeTarget === "string" ? properties.attributeTarget : null,
            line,
            decoratorId: decorator.id,
            usingNamespaces: fileId ? usingsInScope(graph, fileId, namespace, line).namespaces : [],
          };
        })
        .sort((a, b) => a.line - b.line);
    },
  };
}

// Namespaces of the frameworks the C# contributors know: a using of one of them (and of none of the requested
// prefixes) shows an unqualified attribute is that other framework's.
const KNOWN_FRAMEWORK_NAMESPACES = [
  "Microsoft.AspNetCore",
  "Microsoft.Azure.Functions",
  "Microsoft.Azure.WebJobs",
  "Microsoft.Extensions",
  "Grpc",
  "System.CommandLine",
  "Microsoft.AspNetCore.SignalR",
];

export const inNamespace = (name: string, prefix: string): boolean => name === prefix || name.startsWith(prefix.endsWith(".") ? prefix : `${prefix}.`);

/**
 * The attribute(s) named `simpleName` (without `Attribute`; `HttpGet` matches `[HttpGet]`, `[HttpGetAttribute]` and
 * `[Microsoft.AspNetCore.Mvc.HttpGet]`). With `namespacePrefixes` the namespace must fit; the one rule for every C#
 * contributor:
 *   - an attribute that resolves to a type the scan declares is the user's own: rejected;
 *   - a dotted name must start with a requested prefix, written whole or under one of the file's `using`s;
 *   - an unqualified name counts when a `using` brings a requested prefix in; it is rejected when a `using` brings in
 *     another known framework's namespace and none of the requested ones; otherwise (no framework using: implicit
 *     usings, a global namespace, a missing using) it counts.
 */
export function findAttributes(list: readonly CSharpAttributeInfo[], simpleName: string, namespacePrefixes?: readonly string[]): CSharpAttributeInfo[] {
  return list.filter((attribute) => {
    if (attribute.simpleName !== stripSuffix(simpleName)) return false;
    if (!namespacePrefixes || namespacePrefixes.length === 0) return true;
    if (attribute.ownType) return false;
    const fits = (name: string) => namespacePrefixes.some((prefix) => inNamespace(name, prefix));
    if (attribute.qualifiedName !== null) return fits(attribute.qualifiedName) || attribute.usingNamespaces.some((using) => fits(`${using}.${attribute.qualifiedName}`));
    const usings = attribute.usingNamespaces;
    if (usings.some((using) => namespacePrefixes.some((prefix) => inNamespace(using, prefix) || inNamespace(prefix, using) && using !== ""))) return true;
    return !usings.some((using) => KNOWN_FRAMEWORK_NAMESPACES.some((known) => inNamespace(using, known)));
  });
}

export const hasAttribute = (list: readonly CSharpAttributeInfo[], simpleName: string, namespacePrefixes?: readonly string[]): boolean =>
  findAttributes(list, simpleName, namespacePrefixes).length > 0;

// ---------------------------------------------------------------- reading arguments

/** One argument value: `resolved` is false for anything but string literals (a constant, `nameof`, interpolation, a call), `value` then being the expression as written. */
export type AttributeValue = { value: string; resolved: boolean };

// Splits at `separator` outside strings, braces, brackets and parentheses.
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let verbatim = false;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quote) {
      if (char === "\\" && !verbatim) i += 1;
      else if (char === quote) {
        if (verbatim && text[i + 1] === quote) i += 1;
        else quote = null;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      verbatim = char === '"' && text[i - 1] === "@";
    } else if (char === "{" || char === "(" || char === "[") depth += 1;
    else if (char === "}" || char === ")" || char === "]") depth -= 1;
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts;
}

function unescapeCSharp(body: string): string {
  return body.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{1,4}|[0abtnfvr"'\\])/gu, (_, code: string) => {
    if (code.startsWith("u") || code.startsWith("x")) return String.fromCharCode(parseInt(code.slice(1), 16));
    return ({ "0": "\0", a: "\x07", b: "\b", t: "\t", n: "\n", f: "\f", v: "\v", r: "\r" } as Record<string, string>)[code] ?? code;
  });
}

/**
 * The value of one C# string literal expression: `"a"`, `@"a""b"` (verbatim), `"""raw"""`, literals joined by `+`,
 * parentheses around them. Null for anything else (interpolated `$"..."`, constants, calls).
 */
export function csharpStringLiteral(expression: string): string | null {
  let result = "";
  for (const raw of splitTopLevel(expression, "+")) {
    const part = raw.trim();
    const wrapped = /^\(([^()]*)\)$/u.exec(part)?.[1];
    if (wrapped !== undefined) {
      const inner = csharpStringLiteral(wrapped);
      if (inner === null) return null;
      result += inner;
    } else if (/^"""[\s\S]*"""$/u.test(part)) result += part.slice(3, -3);
    else if (/^@"(?:[^"]|"")*"$/u.test(part)) result += part.slice(2, -1).replace(/""/gu, '"');
    else if (/^"(?:[^"\\\n]|\\.)*"$/u.test(part)) result += unescapeCSharp(part.slice(1, -1));
    else return null;
  }
  return result;
}

const KEYED = /^([A-Za-z_]\w*)=(?!=)([\s\S]*)$/u;

/** Positional (unnamed) argument expressions in order. Named ones (`Name="x"`, `name: "x"`) are left out. */
export const positionalArguments = (attribute: Pick<CSharpAttributeInfo, "args">): string[] => attribute.args.filter((arg) => !KEYED.test(arg));

/** The raw expression of the argument named `key` (`Name`/`Template`/`Order`...), null when absent. */
export function namedArgument(attribute: Pick<CSharpAttributeInfo, "args">, key: string): string | null {
  for (const arg of attribute.args) {
    const match = KEYED.exec(arg);
    if (match && match[1] === key) return match[2]!;
  }
  return null;
}

/** The raw expression of the named argument `key`, else the positional one at `index` (null when absent). */
export const argumentExpression = (attribute: Pick<CSharpAttributeInfo, "args">, index: number, key?: string): string | null =>
  (key === undefined ? null : namedArgument(attribute, key)) ?? positionalArguments(attribute)[index] ?? null;

/** Resolves a raw expression to a string: a literal is resolved, anything else is returned as written with `resolved: false`. */
export function attributeValue(expression: string | null): AttributeValue | null {
  if (expression === null) return null;
  const literal = csharpStringLiteral(expression);
  return literal === null ? { value: expression, resolved: false } : { value: literal, resolved: true };
}

/** `typeof(Foo<int>)` / `typeof(A.B)` as the type text written inside, null when the expression is no `typeof`. */
export const typeofArgument = (expression: string | null): string | null => (expression === null ? null : /^typeof\(\s*([\s\S]+?)\s*\)$/u.exec(expression)?.[1] ?? null);

/** Elements of `new[] { "a", "b" }`, `new string[] { ... }`, `{ ... }` or a collection expression `["a", "b"]` as raw expressions; a single expression is one element. */
export function arrayElements(expression: string): string[] {
  const text = expression.trim();
  const body = /^(?:new\s*(?:[\w.<>?]*)\s*\[\s*\]\s*)?\{([\s\S]*)\}$/u.exec(text)?.[1] ?? (/^\[([\s\S]*)\]$/u.exec(text)?.[1] ?? null);
  return body === null ? [text] : splitTopLevel(body, ",").filter((part) => part !== "");
}

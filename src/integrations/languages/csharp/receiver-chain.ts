import { normalizeCSharpType } from "./syntax.js";

// The receiver of a call as text (`new Printer().Print("a").Self()`, `((Shape)x)`, `"hi"`) cut into the parts the
// call resolver walks. Anything it does not know (indexing, lambdas, operators) makes the whole chain unknown.
export type Segment =
  | { kind: "name"; name: string }
  | { kind: "call"; name: string; argCount: number }
  | { kind: "new"; typeName: string; /** The type as written, with its generic arguments (`Box<Foo>`). */ written: string; argCount: number }
  | { kind: "literal"; type: string }
  /** `(expr)`, `((T)expr)` (cast: `cast` is T) or `(expr as T)`. */
  | { kind: "paren"; inner: string; cast: string | null };

// Sticky patterns: matched at `position` of the source, so the walk never slices the rest of the text.
const identifier = /[\p{L}_@][\p{L}\p{N}_]*/uy;
const stringStart = /(?:\$@|@\$|\$|@)?"/uy;
const numberLiteral = /(?:\d+\.\d+(?:[dDfFmM])?|\d+(?:[uUlL]{0,2})|true|false|'(?:\\.|[^'\\])')(?![\p{L}\p{N}_])/uy;
const matchAt = (pattern: RegExp, source: string, position: number): string | undefined => {
  pattern.lastIndex = position;
  return pattern.exec(source)?.[0];
};

export function splitChain(text: string): Segment[] | null {
  const segments: Segment[] = [];
  let position = 0;
  // `global::A.B` is `A.B`.
  const source = text.trim().replace(/^global::/u, "");
  while (position < source.length) {
    if (source.startsWith("new ", position) || source.startsWith("new(", position)) {
      let end = position + 3;
      while (source[end] === " ") end += 1;
      let depth = 0;
      while (end < source.length && (depth > 0 || (source[end] !== "(" && source[end] !== "{" && source[end] !== "["))) {
        if (source[end] === "<") depth += 1;
        else if (source[end] === ">") depth -= 1;
        end += 1;
      }
      if (source[end] !== "(") return null;
      const typeName = normalizeCSharpType(source.slice(position + 3, end));
      const close = matching(source, end);
      if (!typeName || close < 0) return null;
      segments.push({ kind: "new", typeName, written: source.slice(position + 3, end).trim(), argCount: countArguments(source.slice(end + 1, close)) });
      position = close + 1;
      // An object or collection initializer, `{ A = 1 }`.
      while (source[position] === " ") position += 1;
      if (source[position] === "{") {
        const closeBrace = closing(source, position, "{", "}");
        if (closeBrace < 0) return null;
        position = closeBrace + 1;
      }
    } else if (matchAt(stringStart, source, position) !== undefined) {
      const prefix = matchAt(stringStart, source, position)!;
      const start = position + prefix.length - 1;
      let end = start + 1;
      const verbatim = prefix.includes("@");
      while (end < source.length) {
        if (!verbatim && source[end] === "\\") end += 2;
        else if (verbatim && source[end] === "\"" && source[end + 1] === "\"") end += 2;
        else if (source[end] === "\"") break;
        else end += 1;
      }
      if (end >= source.length) return null;
      segments.push({ kind: "literal", type: "string" });
      position = end + 1;
    } else if (source[position] === "(") {
      const close = matching(source, position);
      if (close < 0) return null;
      const inner = source.slice(position + 1, close);
      segments.push({ kind: "paren", inner, cast: castTypeOf(inner) });
      position = close + 1;
    } else {
      const literal = segments.length === 0 ? matchAt(numberLiteral, source, position) : undefined;
      if (literal) {
        segments.push({ kind: "literal", type: literalType(literal) });
        position += literal.length;
      } else {
        const name = matchAt(identifier, source, position);
        if (!name) return null;
        position += name.length;
        // `Name<T>(..)`: a generic method call.
        if (source[position] === "<") {
          let depth = 0;
          let end = position;
          for (; end < source.length; end += 1) {
            if (source[end] === "<") depth += 1;
            else if (source[end] === ">") {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          if (depth !== 0 || source[end + 1] !== "(") return null;
          position = end + 1;
        }
        if (source[position] === "(") {
          const close = matching(source, position);
          if (close < 0) return null;
          segments.push({ kind: "call", name: name.replace(/^@/u, ""), argCount: countArguments(source.slice(position + 1, close)) });
          position = close + 1;
        } else {
          segments.push({ kind: "name", name: name.replace(/^@/u, "") });
        }
      }
    }
    if (source[position] === "!" && source[position + 1] !== "=") position += 1;
    if (position < source.length) {
      if (source.startsWith("?.", position)) position += 2;
      else if (source[position] === ".") position += 1;
      else return null;
    }
  }
  return segments;
}

function literalType(literal: string): string {
  if (literal === "true" || literal === "false") return "bool";
  if (literal.startsWith("'")) return "char";
  if (/^\d+\.\d+[fF]$/u.test(literal)) return "float";
  if (/^\d+\.\d+[mM]$/u.test(literal)) return "decimal";
  if (literal.includes(".")) return "double";
  if (/[lL]$/u.test(literal)) return "long";
  return "int";
}

// `(T)x` inside the outer parentheses, or `x as T`.
function castTypeOf(inner: string): string | null {
  const text = inner.trim();
  if (text.startsWith("(")) {
    const close = matching(text, 0);
    if (close > 0 && close < text.length - 1) {
      const written = text.slice(1, close);
      return normalizeCSharpType(written) !== null && /^[\p{L}_@][\p{L}\p{N}_.<>,?[\] ]*$/u.test(written) ? written : null;
    }
    return null;
  }
  const as = /^[\s\S]*?\s+as\s+([\p{L}_@][\p{L}\p{N}_.<>,?[\] ]*)$/u.exec(text);
  return as && normalizeCSharpType(as[1]) !== null ? as[1]!.trim() : null;
}

// The index of the `)` that closes the `(` at `open`, or -1.
function matching(text: string, open: number): number {
  return closing(text, open, "(", ")");
}
function closing(text: string, open: number, opening: string, closer: string): number {
  let depth = 0;
  let quote: string | null = null;
  for (let position = open; position < text.length; position += 1) {
    const char = text[position]!;
    if (quote) {
      if (char === "\\") position += 1;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === opening) {
      depth += 1;
    } else if (char === closer) {
      depth -= 1;
      if (depth === 0) return position;
    }
  }
  return -1;
}

export function countArguments(text: string): number {
  if (text.trim() === "") return 0;
  let count = 1;
  let depth = 0;
  let quote: string | null = null;
  for (let position = 0; position < text.length; position += 1) {
    const char = text[position]!;
    if (quote) {
      if (char === "\\") position += 1;
      else if (char === quote) quote = null;
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === "(" || char === "[" || char === "{") {
      depth += 1;
    } else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
    } else if (char === "," && depth === 0) {
      count += 1;
    }
  }
  return count;
}

// ---- Types outside the scan ----
const aliases: Record<string, string> = {
  String: "string", Int32: "int", Int64: "long", Int16: "short", UInt32: "uint", UInt64: "ulong", UInt16: "ushort", Boolean: "bool", Double: "double", Single: "float",
  Decimal: "decimal", Char: "char", Byte: "byte", SByte: "sbyte", Object: "object",
};

/** `System.String`, `String` and `string` are one type; other names keep their last segment (`List`). */
export function canonicalExternalType(name: string): string {
  const last = name.replace(/^global::/u, "").split(".").at(-1) ?? name;
  if (name.endsWith("[]")) return name;
  return aliases[last] ?? last;
}

const collection = ["IEnumerable"];
const list = ["IList", "ICollection", "IReadOnlyList", "IReadOnlyCollection", "IEnumerable"];
const knownSupertypes: Record<string, string[]> = {
  string: ["IEnumerable", "IComparable", "IEquatable", "ICloneable"],
  int: ["IComparable", "IEquatable", "IFormattable"], long: ["IComparable", "IEquatable", "IFormattable"], double: ["IComparable", "IEquatable", "IFormattable"],
  decimal: ["IComparable", "IEquatable", "IFormattable"], bool: ["IComparable", "IEquatable"], char: ["IComparable", "IEquatable"],
  List: list, IList: ["ICollection", "IReadOnlyList", "IEnumerable"], ICollection: collection, IReadOnlyList: ["IReadOnlyCollection", "IEnumerable"], HashSet: ["ISet", "ICollection", "IEnumerable"],
  Array: list, Dictionary: ["IDictionary", "IReadOnlyDictionary", "ICollection", "IEnumerable"], IDictionary: ["ICollection", "IEnumerable"],
  Stack: ["ICollection", "IEnumerable"], Queue: ["ICollection", "IEnumerable"], IQueryable: collection,
};

/** The System supertypes of an external type that extension methods are commonly written on. */
export function externalSupertypes(name: string): string[] {
  if (name.endsWith("[]")) return ["Array", ...list];
  return knownSupertypes[name] ?? [];
}

export function isTypeVariableName(name: string, parameters: readonly string[]): boolean {
  return !name.includes(".") && parameters.includes(name);
}

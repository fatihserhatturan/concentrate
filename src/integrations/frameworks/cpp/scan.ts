import type { GraphNode } from "../../../core/graph/model.js";

// A text reader for the C and C++ framework layers. Frameworks register
// routes and read config through macros (`CROW_ROUTE`, `METHOD_ADD`) and
// calls the grammar cannot always keep (a macro at class scope is a syntax
// error), so the layers read the written source: comments are blanked and the
// contents of string literals hidden for finding calls, while the literals
// themselves stay readable. Offsets are the same in every view.

export type CppSource = {
  // The source with comments blanked (strings intact).
  text: string;
  // `text` with the contents of strings and char literals blanked.
  code: string;
  lineAt(offset: number): number;
  columnAt(offset: number): number;
  // The offset where a (1-based) line starts.
  offsetOfLine(line: number): number;
};

export function readCppSource(source: string): CppSource {
  const length = source.length;
  const text: string[] = source.split("");
  const code: string[] = source.split("");
  const blank = (list: string[], from: number, to: number) => {
    for (let index = from; index < to; index += 1) if (list[index] !== "\n" && list[index] !== "\r") list[index] = " ";
  };
  let index = 0;
  while (index < length) {
    const char = source[index]!;
    const next = source[index + 1];
    if (char === "/" && next === "/") {
      let end = index;
      // A line comment continues over a backslash-newline.
      while (end < length && !(source[end] === "\n" && source[end - 1] !== "\\" && !(source[end - 1] === "\r" && source[end - 2] === "\\"))) end += 1;
      blank(text, index, end);
      blank(code, index, end);
      index = end;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = source.indexOf("*/", index + 2);
      const end = close === -1 ? length : close + 2;
      blank(text, index, end);
      blank(code, index, end);
      index = end;
      continue;
    }
    if (char === "\"") {
      // A raw string `R"delim( … )delim"` (any prefix before the R).
      const rawPrefix = index > 0 && source[index - 1] === "R" && (!/\w/u.test(source[index - 2] ?? "") || /(?:u8|u|U|L)R$/u.test(source.slice(Math.max(0, index - 3), index)));
      const raw = rawPrefix ? /^"([^()\\\s]{0,16})\(/u.exec(source.slice(index, index + 20)) : null;
      if (raw) {
        const closer = `)${raw[1]}"`;
        const close = source.indexOf(closer, index + raw[0].length);
        const end = close === -1 ? length : close + closer.length;
        blank(code, index + 1, end - 1);
        index = end;
        continue;
      }
      let end = index + 1;
      while (end < length && source[end] !== "\"" && source[end] !== "\n") end += source[end] === "\\" ? 2 : 1;
      blank(code, index + 1, Math.min(end, length));
      index = end + 1;
      continue;
    }
    if (char === "'") {
      // A digit separator (`1'000`) is not a char literal.
      if (index > 0 && /[0-9A-Fa-f]/u.test(source[index - 1]!) && /[0-9A-Fa-f]/u.test(next ?? "")) {
        index += 1;
        continue;
      }
      let end = index + 1;
      while (end < length && source[end] !== "'" && source[end] !== "\n") end += source[end] === "\\" ? 2 : 1;
      blank(code, index + 1, Math.min(end, length));
      index = end + 1;
      continue;
    }
    index += 1;
  }

  // A macro's body is not a call: `#define METHOD_ADD(m, p, ...) …`.
  for (const define of source.matchAll(/^[ \t]*#[ \t]*define\b[^\n]*(?:\\\r?\n[^\n]*)*/gmu)) blank(code, define.index, define.index + define[0].length);

  const lineStarts = [0];
  for (let position = 0; position < length; position += 1) if (source[position] === "\n") lineStarts.push(position + 1);
  const lineIndex = (offset: number) => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low;
  };
  return {
    text: text.join(""),
    code: code.join(""),
    lineAt: (offset) => lineIndex(offset) + 1,
    columnAt: (offset) => offset - lineStarts[lineIndex(offset)]!,
    offsetOfLine: (line) => lineStarts[Math.min(Math.max(line, 1), lineStarts.length) - 1]!,
  };
}

export type Invocation = {
  // The called name, as matched.
  name: string;
  // What stands before it: `app().`, `Routes::`, `svr.`, `cpr::`.
  prefix: string;
  // The receiver of a `.` / `->` call (`svr`, `this->db_`), else null.
  receiver: string | null;
  // The `::` qualifier (`cpr`, `drogon::app()` …), else null.
  qualifier: string | null;
  // Offsets: of the name, of the `(`, and just after the `)`.
  start: number;
  open: number;
  end: number;
  line: number;
  column: number;
  args: string[];
  // Where each argument starts.
  argStarts: number[];
};

const PREFIX = /((?:(?:[A-Za-z_]\w*)(?:\s*(?:<[^<>;(){}]*>)?\s*\(\s*\))?\s*(?:::|\.|->)\s*)+|::\s*)$/u;

// Every call of a name matching `names` (a regular expression source of the
// bare name), with its arguments.
export function findInvocations(source: CppSource, names: string, from = 0, to = source.code.length): Invocation[] {
  const pattern = new RegExp(String.raw`(?<![\w$])(${names})\s*(?:<[^;(){}]*?>\s*)?\(`, "gu");
  const found: Invocation[] = [];
  const { code, text } = source;
  pattern.lastIndex = from;
  for (let match = pattern.exec(code); match && match.index < to; match = pattern.exec(code)) {
    const open = match.index + match[0].length - 1;
    const close = matching(code, open);
    if (close === -1) continue;
    const { args, argStarts } = readArguments(source, open, close);
    const before = code.slice(Math.max(0, match.index - 200), match.index);
    const prefix = PREFIX.exec(before)?.[1]?.replace(/\s+/gu, "") ?? "";
    const accessor = /(?:\.|->)$/u.test(prefix);
    found.push({
      name: match[1]!,
      prefix,
      receiver: accessor ? prefix.replace(/(?:\.|->)$/u, "") : null,
      qualifier: prefix.endsWith("::") ? prefix.slice(0, -2) : null,
      start: match.index,
      open,
      end: close + 1,
      line: source.lineAt(match.index),
      column: source.columnAt(match.index),
      args,
      argStarts,
    });
  }
  return found;
}

// The top-level arguments between the parentheses at `open` and `close`.
export function readArguments(source: CppSource, open: number, close: number): { args: string[]; argStarts: number[] } {
  const { code, text } = source;
  const args: string[] = [];
  const argStarts: number[] = [];
  let depth = 0;
  let start = open + 1;
  for (let position = open + 1; position < close; position += 1) {
    const char = code[position]!;
    if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      args.push(text.slice(start, position).trim());
      argStarts.push(start);
      start = position + 1;
    }
  }
  const last = text.slice(start, close).trim();
  if (last !== "" || args.length > 0) {
    args.push(last);
    argStarts.push(start);
  }
  return { args, argStarts };
}

// The offset of the bracket that closes the one at `open`, or -1.
export function matching(code: string, open: number): number {
  const pairs: Record<string, string> = { "(": ")", "[": "]", "{": "}" };
  const stack: string[] = [];
  for (let position = open; position < code.length; position += 1) {
    const char = code[position]!;
    if (pairs[char]) stack.push(pairs[char]!);
    else if (char === ")" || char === "]" || char === "}") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return position;
    }
  }
  return -1;
}

export type CppScope = { kind: "namespace" | "class"; name: string; start: number; end: number };

// The namespaces and classes of the file with the offsets of their bodies,
// whatever the grammar made of them.
export function scopesOf(source: CppSource): CppScope[] {
  const scopes: CppScope[] = [];
  const pattern = /\b(namespace|class|struct)\s+((?:[A-Za-z_]\w*\s*(?:::\s*)?)+?)\s*(?:final\s*)?(?::(?!:)[^{};]*)?\{/gu;
  for (let match = pattern.exec(source.code); match; match = pattern.exec(source.code)) {
    const open = match.index + match[0].length - 1;
    const close = matching(source.code, open);
    if (close === -1) continue;
    const name = match[2]!.replace(/\s+/gu, "");
    scopes.push({ kind: match[1] === "namespace" ? "namespace" : "class", name, start: open, end: close });
  }
  return scopes;
}

// The `ns::Class` chain around an offset: namespaces and the innermost class.
export function scopeAt(scopes: readonly CppScope[], offset: number): { namespace: string; className: string | null } {
  const around = scopes.filter((scope) => scope.start < offset && offset < scope.end).sort((left, right) => left.start - right.start);
  const namespaces = around.filter((scope) => scope.kind === "namespace").map((scope) => scope.name);
  const classes = around.filter((scope) => scope.kind === "class");
  return { namespace: namespaces.join("::"), className: classes.at(-1)?.name ?? null };
}

const ONE_STRING = /(?:u8|u|U|L)?(?:"((?:[^"\\\n]|\\.)*)"|R"([^()\\\s]{0,16})\(([\s\S]*?)\)\2")/gu;

// A string literal written as one or more adjacent literals, escapes undone
// (a raw string as it is); null for anything else.
export function stringLiteral(written: string): string | null {
  const trimmed = written.trim();
  if (!/^(?:u8|u|U|L|R)*"/u.test(trimmed)) return null;
  const check = new RegExp(String.raw`^\s*(?:(?:u8|u|U|L)?"(?:[^"\\\n]|\\.)*"|(?:u8|u|U|L)?R"([^()\\\s]{0,16})\([\s\S]*?\)\1")(?:\s*(?:(?:u8|u|U|L)?"(?:[^"\\\n]|\\.)*"|(?:u8|u|U|L)?R"([^()\\\s]{0,16})\([\s\S]*?\)\2"))*\s*$`, "u");
  if (!check.test(trimmed)) return null;
  let value = "";
  for (const match of trimmed.matchAll(ONE_STRING)) {
    value += match[1] !== undefined ? unescape(match[1]) : match[3] ?? "";
  }
  return value;
}

function unescape(body: string): string {
  return body.replace(/\\(?:x([0-9a-fA-F]{1,2})|([0-7]{1,3})|(.))/gsu, (_whole, hex?: string, octal?: string, char?: string) => {
    if (hex) return String.fromCharCode(Number.parseInt(hex, 16));
    if (octal) return String.fromCharCode(Number.parseInt(octal, 8));
    switch (char) {
      case "n": return "\n";
      case "t": return "\t";
      case "r": return "\r";
      case "0": return "\0";
      default: return char ?? "";
    }
  });
}

// The string constants of a file: `#define X "…"`, `const char *X = "…"`,
// `constexpr auto X = "…"`, `static const std::string X = "…"` /
// `X{"…"}`.
export function stringConstants(source: CppSource): Map<string, string> {
  const constants = new Map<string, string>();
  const literal = String.raw`((?:(?:u8|u|U|L)?"(?:[^"\\\n]|\\.)*"\s*)+)`;
  for (const match of source.text.matchAll(new RegExp(String.raw`^[ \t]*#[ \t]*define[ \t]+([A-Za-z_]\w*)[ \t]+(?:\(\s*)?${literal}`, "gmu"))) {
    const value = stringLiteral(match[2]!);
    if (value !== null) constants.set(match[1]!, value);
  }
  for (const match of source.text.matchAll(new RegExp(String.raw`\b(?:const|constexpr|static)\b[^;=(){}"]*?\b([A-Za-z_]\w*)\s*(?:\[\s*\])?\s*(?:=|\{)\s*(?:(?:std::)?(?:string|string_view)\s*[({]\s*|QStringLiteral\s*\(\s*|QLatin1String\s*\(\s*)?${literal}`, "gu"))) {
    const value = stringLiteral(match[2]!);
    if (value !== null && !constants.has(match[1]!)) constants.set(match[1]!, value);
  }
  return constants;
}

const WRAPPERS = /^(?:(?:std::)?string|std::string_view|string_view|QString|QStringLiteral|QLatin1String|QUrl|QByteArray|cpr::Url|Url|cpr::Body|std::filesystem::path)\s*[({]([\s\S]*)[)}]$/u;

// The value of a string expression: a literal, a constant, `std::string("…")`,
// `x.c_str()` of a constant, adjacent literals; null for anything else.
export function stringValue(written: string, constants: ReadonlyMap<string, string>): string | null {
  let expression = written.trim();
  for (let guard = 0; guard < 4; guard += 1) {
    const wrapped = WRAPPERS.exec(expression);
    if (!wrapped) break;
    expression = wrapped[1]!.trim();
  }
  expression = expression.replace(/\.(?:c_str|data|str|toStdString|toUtf8|toLatin1|constData)\(\s*\)$/u, "").replace(/^\(\s*(?:const\s+)?(?:unsigned\s+)?(?:char|SQLCHAR|SQLWCHAR)\s*\*\s*\)\s*/u, "").trim();
  const literal = stringLiteral(expression);
  if (literal !== null) return literal;
  if (/^(?:[A-Za-z_]\w*::)*[A-Za-z_]\w*$/u.test(expression)) return constants.get(expression.replace(/^(?:\w+::)*/u, "")) ?? null;
  return null;
}

// The function node an offset (line) falls in, the smallest first; the file
// when none does.
export function ownerOf(nodes: readonly GraphNode[], fileNodeId: string): (line: number) => string {
  const owners = nodes
    .filter((node) => node.label === "Function" && node.properties.kind !== "macro" && node.properties.isDeclaration !== true
      && typeof node.properties.line === "number" && typeof node.properties.endLine === "number")
    .map((node) => ({ id: node.id, line: Number(node.properties.line), endLine: Number(node.properties.endLine) }));
  return (line) => owners
    .filter((owner) => owner.line <= line && line <= owner.endLine)
    .sort((left, right) => (left.endLine - left.line) - (right.endLine - right.line))[0]?.id ?? fileNodeId;
}

export const HTTP_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "TRACE", "CONNECT"]);

const LOCAL_TYPES = String.raw`(?:const\s+)?(?:static\s+)?(?:std::string|std::string_view|string|QString|QByteArray|const\s+char\s*\*(?:\s*const)?|char\s*\*|auto|std::string&|QUrl|cpr::Url)`;

// The text an expression stands for, when it is made of literals, constants
// and locals: `"a" + b` (b a local or constant of the function), `x.c_str()`,
// `std::string("a")`. Anything else in it becomes `${name}`; null when no
// part is known at all.
export function resolveString(source: CppSource, expression: string, before: number, from: number, constants: ReadonlyMap<string, string>, depth = 0): string | null {
  // `(a + b).c_str()` and `(a + b)`.
  let inner = expression.trim();
  for (let guard = 0; guard < 3; guard += 1) {
    const unwrapped = inner.replace(/\.(?:c_str|data|str|toStdString|toUtf8|constData)\(\s*\)$/u, "").trim();
    inner = unwrapped.startsWith("(") && unwrapped.endsWith(")") && matching(unwrapped, 0) === unwrapped.length - 1 ? unwrapped.slice(1, -1).trim() : unwrapped;
  }
  const parts = splitConcatenation(inner);
  let known = false;
  const pieces = parts.map((part) => {
    const direct = stringValue(part, constants);
    if (direct !== null) {
      known = true;
      return direct;
    }
    const name = /^([A-Za-z_]\w*)(?:\.(?:c_str|data|str|toStdString|toUtf8|constData)\(\s*\))?$/u.exec(part.trim())?.[1];
    if (name && depth < 4) {
      const assigned = localAssignment(source, name, before, from);
      if (assigned !== null) {
        const value = resolveString(source, assigned.expression, assigned.at, from, constants, depth + 1);
        if (value !== null) {
          known = true;
          return value;
        }
      }
    }
    const converted = /^(?:std::)?to_string\s*\(([\s\S]*)\)$/u.exec(part.trim())?.[1] ?? part.trim();
    return `\${${converted.replace(/[{}/\s?#]/gu, "_").slice(0, 40)}}`;
  });
  return known ? pieces.join("") : null;
}

// The last initialization or assignment of a local before an offset, within
// the function that starts at `from`.
function localAssignment(source: CppSource, name: string, before: number, from: number): { expression: string; at: number } | null {
  const window = source.code.slice(from, before);
  const pattern = new RegExp(String.raw`(?:^|[;{}(,\s])(?:${LOCAL_TYPES}\s*[&*]?\s+)?\b${name}\s*(?:=|\{|\()(?!=)`, "gu");
  let found: { expression: string; at: number } | null = null;
  for (let match = pattern.exec(window); match; match = pattern.exec(window)) {
    const start = from + match.index + match[0].length;
    const opener = match[0].at(-1)!;
    let end: number;
    if (opener === "=") {
      end = source.code.indexOf(";", start);
    } else {
      const close = matching(source.code, start - 1);
      end = close;
    }
    if (end === -1 || end > before) continue;
    const expression = source.text.slice(start, end).trim();
    if (expression === "" || new RegExp(String.raw`\b${name}\b`, "u").test(expression) && !expression.includes("\"")) continue;
    found = { expression, at: start };
  }
  return found;
}

// `a + b + "c"` split at top-level plus signs.
function splitConcatenation(expression: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let start = 0;
  for (let position = 0; position < expression.length; position += 1) {
    const char = expression[position]!;
    if (inString) {
      if (char === "\\") position += 1;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "+" && depth === 0) {
      parts.push(expression.slice(start, position).trim());
      start = position + 1;
    }
  }
  parts.push(expression.slice(start).trim());
  return parts.filter((part) => part !== "");
}

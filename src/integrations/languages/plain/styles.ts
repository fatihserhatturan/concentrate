// A reader for CSS, SCSS and Less: rules with their class and id selectors,
// custom property definitions and `var(--x)` uses, and the files a style sheet
// pulls in (`@import`, `@use`, `@forward`, `url()`, CSS Modules `composes` and
// `@value … from`).
//
// It is a scanner, not a parser. The vendored css and scss grammars reject
// valid code that real projects contain (`@use "x" as y`, `--x: #{$v}`, range
// media queries), and an error node there would drop the rest of the file. The
// scanner follows comments, strings, `url(…)`, parentheses, `#{…}`
// interpolation and braces, which is all the structure these facts need.

export type StyleLanguage = "css" | "scss" | "less";

export type StyleRule = {
  // The rule's selector as written, whitespace collapsed (at most 200 chars).
  selector: string;
  line: number;
  endLine: number;
  // The at-rules it is nested in (`@media (min-width: 40em)`), outermost first.
  atRule: string | null;
  classes: string[];
  ids: string[];
};

export type StyleName = { name: string; line: number; scope: "global" | null };

export type StyleImportKind = "import" | "use" | "forward" | "url" | "composes";

export type StyleImport = {
  // As written for a path (`./a`, `partials/b`), `./`-prefixed for a bare
  // `url()` and a bare CSS `@import`, which are relative.
  source: string;
  line: number;
  kind: StyleImportKind;
  text: string;
  // `@use "x" as y`.
  alias: string | null;
};

export type StyleReading = {
  rules: StyleRule[];
  classes: Map<string, StyleName>;
  ids: Map<string, StyleName>;
  definitions: Map<string, StyleName>;
  varUses: Array<{ name: string; line: number }>;
  imports: StyleImport[];
};

const MAX_SELECTOR_TEXT = 200;
// Selectors a nested rule can expand to (`.a, .b { .c, .d { … } }` is four).
const MAX_RESOLVED = 64;

// At-rules whose block holds declarations or keyframe selectors, not rules.
const declarationAtRules = new Set([
  "keyframes", "-webkit-keyframes", "-moz-keyframes", "-o-keyframes", "font-face", "page", "property",
  "counter-style", "font-palette-values", "viewport", "font-feature-values", "color-profile", "view-transition",
]);
// At-rules whose body is a template for another place: `&` has no parent.
const templateAtRules = new Set(["mixin", "function", "at-root"]);

type Block = {
  kind: "rule" | "pass" | "declarations";
  // Selectors a nested rule resolves `&` and descendants against.
  selectors: string[];
  atRule: string | null;
  rule: StyleRule | null;
};

export function readStyles(source: string, language: StyleLanguage): StyleReading {
  const clean = blankComments(source, language);
  const lineStarts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") lineStarts.push(index + 1);
  }
  const lineAt = (offset: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if (lineStarts[middle]! <= offset) low = middle;
      else high = middle - 1;
    }
    return low + 1;
  };

  const reading: StyleReading = {
    rules: [],
    classes: new Map(),
    ids: new Map(),
    definitions: new Map(),
    varUses: [],
    imports: [],
  };
  const importKeys = new Set<string>();
  const stack: Block[] = [{ kind: "pass", selectors: [], atRule: null, rule: null }];

  const addImport = (entry: StyleImport) => {
    const key = `${entry.line}:${entry.source}`;
    if (importKeys.has(key)) return;
    importKeys.add(key);
    reading.imports.push(entry);
  };

  const finishStatement = (start: number, end: number) => {
    const text = clean.slice(start, end);
    if (text.trim() === "") return;
    const first = start + (text.length - text.trimStart().length);
    const trimmed = text.trim();
    const line = lineAt(first);
    const parent = stack[stack.length - 1]!;

    const at = /^@([\w-]+)/u.exec(trimmed);
    if (at) {
      const name = at[1]!.toLowerCase();
      if (name === "import" || name === "use" || name === "forward") {
        for (const found of atRuleSources(trimmed, name)) {
          addImport({ source: found.source, line: lineAt(first + found.offset), kind: name, text: trimmed.slice(0, 200), alias: found.alias });
        }
        return;
      }
      if (name === "value") {
        const from = /\bfrom\s+(["'])(.*?)\1\s*$/u.exec(trimmed);
        const target = from ? cleanSource(from[2]!, "relative") : null;
        if (target) addImport({ source: target, line, kind: "composes", text: trimmed.slice(0, 200), alias: null });
        return;
      }
    }

    scanUses(trimmed, first);

    const declaration = /^(--[^\s:;{}()]+|[$@]?[\w-]+)\s*:/u.exec(trimmed);
    const property = declaration?.[1] ?? "";
    if (declaration && (parent.kind !== "pass" || property.startsWith("--"))) {
      if (property.startsWith("--") && !property.includes("#")) {
        if (!reading.definitions.has(property)) reading.definitions.set(property, { name: property, line, scope: null });
      }
      if (property === "composes") {
        const from = /\bfrom\s+(["'])(.*?)\1\s*$/u.exec(trimmed);
        const target = from ? cleanSource(from[2]!, "relative") : null;
        if (target) addImport({ source: target, line, kind: "composes", text: trimmed.slice(0, 200), alias: null });
      }
    }
  };

  // `var(--x)` uses and `url(…)` references in a declaration or statement.
  const scanUses = (text: string, base: number) => {
    for (const match of text.matchAll(/\bvar\(\s*(--[^\s,)#]+)/gu)) {
      reading.varUses.push({ name: match[1]!, line: lineAt(base + match.index) });
    }
    for (const match of text.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)/giu)) {
      const target = cleanSource(match[1] ?? match[2] ?? match[3] ?? "", "relative");
      if (target) addImport({ source: target, line: lineAt(base + match.index), kind: "url", text: match[0].slice(0, 200), alias: null });
    }
  };

  const openBlock = (start: number, end: number, braceOffset: number) => {
    const text = clean.slice(start, end);
    const trimmed = text.trim();
    const parent = stack[stack.length - 1]!;
    const first = start + (text.length - text.trimStart().length);
    if (trimmed === "") {
      stack.push({ kind: "pass", selectors: parent.selectors, atRule: parent.atRule, rule: null });
      return;
    }
    if (trimmed.startsWith("@")) {
      const name = /^@([\w-]+)/u.exec(trimmed)?.[1]?.toLowerCase() ?? "";
      const label = trimmed.replace(/\s+/gu, " ").slice(0, MAX_SELECTOR_TEXT);
      if (name === "property") {
        const property = /^@property\s+(--[^\s{]+)/iu.exec(trimmed)?.[1];
        if (property && !reading.definitions.has(property)) reading.definitions.set(property, { name: property, line: lineAt(first), scope: null });
      }
      if (declarationAtRules.has(name)) {
        stack.push({ kind: "declarations", selectors: [], atRule: parent.atRule, rule: null });
        return;
      }
      const atRule = name === "mixin" || name === "function" || name === "include" || name === "if" || name === "else" || name === "each" || name === "for" || name === "while" || name === "at-root"
        ? parent.atRule
        : parent.atRule ? `${parent.atRule} ${label}`.slice(0, MAX_SELECTOR_TEXT) : label;
      stack.push({ kind: "pass", selectors: templateAtRules.has(name) ? [] : parent.selectors, atRule, rule: null });
      return;
    }
    // `font: { family: x; }`, and anything inside a keyframes or font-face block.
    if (parent.kind === "declarations" || /:$/u.test(trimmed)) {
      stack.push({ kind: "declarations", selectors: [], atRule: parent.atRule, rule: null });
      return;
    }
    scanUses(trimmed, first);

    const parts = splitTopLevel(trimmed, ",");
    const resolved: string[] = [];
    const own: Array<{ text: string }> = [];
    for (const part of parts) {
      const selector = part.trim();
      if (selector === "") continue;
      const parents = parent.selectors;
      if (selector.includes("&")) {
        for (const base of parents.length > 0 ? parents : [null]) {
          const expanded = replaceNesting(selector, base);
          if (expanded === null) continue;
          if (resolved.length < MAX_RESOLVED) resolved.push(expanded);
          own.push({ text: expanded });
        }
      } else {
        own.push({ text: selector });
        if (parents.length > 0) {
          for (const base of parents) if (resolved.length < MAX_RESOLVED) resolved.push(`${base} ${selector}`);
        } else if (resolved.length < MAX_RESOLVED) {
          resolved.push(selector);
        }
      }
    }

    const classes = new Set<string>();
    const ids = new Set<string>();
    const line = lineAt(first);
    for (const { text: selector } of own) {
      const names = selectorNames(selector);
      for (const name of names.classes) {
        classes.add(name.name);
        if (!reading.classes.has(name.name)) reading.classes.set(name.name, { name: name.name, line, scope: name.global ? "global" : null });
      }
      for (const name of names.ids) {
        ids.add(name);
        if (!reading.ids.has(name)) reading.ids.set(name, { name, line, scope: null });
      }
    }
    const rule: StyleRule = {
      selector: trimmed.replace(/\s+/gu, " ").slice(0, MAX_SELECTOR_TEXT),
      line,
      endLine: lineAt(braceOffset),
      atRule: parent.atRule,
      classes: [...classes],
      ids: [...ids],
    };
    reading.rules.push(rule);
    stack.push({ kind: "rule", selectors: resolved, atRule: parent.atRule, rule });
  };

  let start = 0;
  let parentheses = 0;
  let index = 0;
  while (index < clean.length) {
    const char = clean[index]!;
    if (char === "\"" || char === "'") {
      index = stringEnd(clean, index) + 1;
      continue;
    }
    if ((char === "u" || char === "U") && /^url\(/iu.test(clean.slice(index, index + 4)) && !/[\w-]/u.test(clean[index - 1] ?? " ")) {
      const end = urlEnd(clean, index + 4);
      index = end + 1;
      continue;
    }
    if (char === "#" && clean[index + 1] === "{") {
      index = balancedEnd(clean, index + 2) + 1;
      continue;
    }
    if (char === "@" && clean[index + 1] === "{") {
      // Less interpolation `@{name}`.
      index = balancedEnd(clean, index + 2) + 1;
      continue;
    }
    if (char === "(") parentheses += 1;
    else if (char === ")") parentheses = Math.max(0, parentheses - 1);
    else if (parentheses === 0) {
      if (char === "{") {
        openBlock(start, index, index);
        start = index + 1;
      } else if (char === ";") {
        finishStatement(start, index);
        start = index + 1;
      } else if (char === "}") {
        finishStatement(start, index);
        if (stack.length > 1) {
          const closed = stack.pop()!;
          if (closed.rule) closed.rule.endLine = lineAt(index);
        }
        start = index + 1;
      }
    }
    index += 1;
  }
  finishStatement(start, clean.length);
  // Blocks the file left open end at its last line.
  for (const block of stack) {
    if (block.rule && block.rule.endLine < block.rule.line) block.rule.endLine = lineAt(clean.length);
  }
  return reading;
}

// `source` with comments replaced by spaces (line breaks and offsets kept).
// `//` comments exist in SCSS and Less only.
function blankComments(source: string, language: StyleLanguage): string {
  const chars = source.split("");
  let index = 0;
  const blank = (from: number, to: number) => {
    for (let at = from; at < to; at += 1) {
      if (chars[at] !== "\n" && chars[at] !== "\r") chars[at] = " ";
    }
  };
  while (index < source.length) {
    const char = source[index]!;
    if (char === "\"" || char === "'") {
      index = stringEnd(source, index) + 1;
    } else if ((char === "u" || char === "U") && /^url\(/iu.test(source.slice(index, index + 4)) && !/[\w-]/u.test(source[index - 1] ?? " ")) {
      index = urlEnd(source, index + 4) + 1;
    } else if (char === "/" && source[index + 1] === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(index, stop);
      index = stop;
    } else if (char === "/" && source[index + 1] === "/" && language !== "css") {
      let end = source.indexOf("\n", index);
      if (end === -1) end = source.length;
      blank(index, end);
      index = end;
    } else {
      index += 1;
    }
  }
  return chars.join("");
}

// The index of the closing quote of the string starting at `start` (the end of
// the text for an unterminated one; a line break ends it, as in CSS).
function stringEnd(text: string, start: number): number {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") index += 1;
    else if (char === quote) return index;
    else if (char === "\n") return index - 1;
  }
  return text.length - 1;
}

// The `)` that closes `url(` (the text after the opening parenthesis starts at
// `start`): a quoted argument can hold `)`, an unquoted one cannot.
function urlEnd(text: string, start: number): number {
  let index = start;
  while (index < text.length && /\s/u.test(text[index]!)) index += 1;
  if (text[index] === "\"" || text[index] === "'") {
    index = stringEnd(text, index) + 1;
  }
  const close = text.indexOf(")", index);
  return close === -1 ? text.length - 1 : close;
}

// The `}` that closes an interpolation whose inside starts at `start`.
function balancedEnd(text: string, start: number): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\"" || char === "'") index = stringEnd(text, index);
    else if (char === "{") depth += 1;
    else if (char === "}") {
      if (depth === 0) return index;
      depth -= 1;
    }
  }
  return text.length - 1;
}

// Splits at `separator` outside parentheses, brackets, strings and
// interpolation.
function splitTopLevel(text: string, separator: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (char === "\"" || char === "'") index = stringEnd(text, index);
    else if (char === "#" && text[index + 1] === "{") index = balancedEnd(text, index + 2);
    else if (char === "(" || char === "[") depth += 1;
    else if (char === ")" || char === "]") depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(text.slice(start));
  return parts;
}

// `&` replaced by the parent selector. Without a parent, `&-x` and `&__x`
// name nothing known (a mixin body), so the selector is dropped; a bare `&`
// becomes nothing.
function replaceNesting(selector: string, base: string | null): string | null {
  if (base === null) {
    if (/&[\w-]/u.test(selector)) return null;
    return selector.replaceAll("&", "");
  }
  return selector.replaceAll("&", base);
}

export function selectorNames(selector: string): { classes: Array<{ name: string; global: boolean }>; ids: string[] } {
  // CSS Modules `:global(.a)` and `:global .a` are not local to the file;
  // `:local(.a)` is.
  const classes: Array<{ name: string; global: boolean }> = [];
  const ids: string[] = [];
  let text = selector.replace(/#\{[^}]*\}/gu, "\u0000").replace(/@\{[^}]*\}/gu, "\u0000");
  text = text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/gu, "\"\"").replace(/\[[^\]]*\]/gu, "[]");
  const collect = (part: string, global: boolean) => {
    for (const match of part.matchAll(/\.(-?(?:[_a-zA-Z]|[^\x00-\x7f]|\\.)(?:[\w-]|[^\x00-\x7f]|\\.)*)/gu)) {
      const before = part[match.index - 1];
      const after = part[match.index + match[0].length];
      // `.a#{$x}`, `#{$x}.a`: part of a name built at compile time.
      if (before === "\u0000" || after === "\u0000") continue;
      // A decimal (`.5`) never matches; a file name (`a.css`) does not occur in selectors.
      classes.push({ name: match[1]!.replace(/\\(.)/gu, "$1"), global });
    }
    for (const match of part.matchAll(/#(-?(?:[_a-zA-Z]|[^\x00-\x7f]|\\.)(?:[\w-]|[^\x00-\x7f]|\\.)*)/gu)) {
      const before = part[match.index - 1];
      const after = part[match.index + match[0].length];
      if (before === "\u0000" || after === "\u0000") continue;
      ids.push(match[1]!.replace(/\\(.)/gu, "$1"));
    }
  };
  // :global(...) / :local(...) with one level of nested parentheses.
  text = text.replace(/:(global|local)\(((?:[^()]|\([^()]*\))*)\)/gu, (_whole, mode: string, inner: string) => {
    collect(inner, mode === "global");
    return " ";
  });
  const bare = /:global\b(?!\()/u.exec(text);
  if (bare) {
    collect(text.slice(0, bare.index), false);
    collect(text.slice(bare.index + bare[0].length).replace(/:local\b(?!\()/gu, " "), true);
  } else {
    collect(text.replace(/:local\b(?!\()/gu, " "), false);
  }
  return { classes, ids };
}

// The sources named by an `@import`, `@use` or `@forward` statement.
function atRuleSources(
  statement: string,
  kind: "import" | "use" | "forward",
): Array<{ source: string; offset: number; alias: string | null }> {
  const found: Array<{ source: string; offset: number; alias: string | null }> = [];
  // A bare name is a package or a load path as often as a sibling file: kept
  // as written, tried beside the sheet, and not counted when not found.
  const relative = "load-path";
  // `@use "x" with (…)`: strings inside parentheses are configuration.
  const head = kind === "import" ? statement : statement.replace(/\(.*$/su, "");
  const alias = kind === "import" ? null : /\bas\s+([\w*-]+)/u.exec(head)?.[1] ?? null;
  // Strings and `url()` in order; a `url("x")` is one source, not two.
  for (const match of head.matchAll(/\burl\(\s*(?:"([^"]*)"|'([^']*)'|([^)"'\s][^)]*?))\s*\)|"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/giu)) {
    const isUrl = match[0].toLowerCase().startsWith("url(");
    const value = isUrl ? match[1] ?? match[2] ?? match[3] ?? "" : match[4] ?? match[5] ?? "";
    // `@use "x" with (…)` was cut off above; `@import url(x) screen` keeps media text after it.
    const target = cleanSource(value, isUrl ? "relative" : relative);
    if (target) found.push({ source: target, offset: match.index, alias });
    if (kind !== "import") break;
  }
  return found;
}

// A usable path of the project, or null for what is not one: a URL, a data
// URI, a fragment (`url(#id)`), a root-relative path, a package (`~pkg`), a
// Sass built-in module (`sass:math`), a string built at compile time. A bare
// `url()` is relative to the style sheet; a bare `@import` / `@use` is kept
// as written (a sibling, a load path or a package).
function cleanSource(value: string, mode: "relative" | "load-path"): string | null {
  const text = value.trim();
  if (text === "" || /^[a-z][a-z\d+.-]*:/iu.test(text) || text.startsWith("//") || text.startsWith("#") || text.startsWith("/") || text.startsWith("~")) return null;
  const path = text.replace(/[?#](?!\{).*$/su, "");
  if (path === "" || /#\{|[$@{}]|\bvar\(/u.test(path)) return null;
  if (mode === "relative" && !path.startsWith(".")) return `./${path}`;
  return path;
}

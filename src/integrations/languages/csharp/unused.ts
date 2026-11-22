import type { IUnusedExportRules } from "../../../core/contracts/unused-rules.js";
import type { Declaration } from "../../../core/queries/model.js";
import { isCSharpFile } from "../file-kind.js";

// Index just past the string literal whose opening quote is at `i`. Handles regular, verbatim (`@"..."`), interpolated
// (`$"..."`, `$@"..."`, `@$"..."`; holes may hold nested strings and `{{` / `}}` are escapes) and raw (`"""`) strings.
function skipString(text: string, i: number): number {
  if (text.startsWith("\"\"\"", i)) {
    let quotes = 3;
    while (text[i + quotes] === "\"") quotes++;
    const end = text.indexOf("\"".repeat(quotes), i + quotes);
    return end < 0 ? text.length : end + quotes;
  }
  const prefix = `${text[i - 2] ?? ""}${text[i - 1] ?? ""}`;
  const verbatim = text[i - 1] === "@" || prefix === "@$" || prefix === "$@";
  const interpolated = text[i - 1] === "$" || prefix === "@$" || prefix === "$@";
  let j = i + 1;
  while (j < text.length) {
    const c = text[j]!;
    if (c === "\"") {
      if (verbatim && text[j + 1] === "\"") j += 2;
      else return j + 1;
    } else if (!verbatim && c === "\\") j += 2;
    else if (!verbatim && c === "\n") return j;
    else if (interpolated && c === "{") j = text[j + 1] === "{" ? j + 2 : skipHole(text, j + 1);
    else if (interpolated && c === "}" && text[j + 1] === "}") j += 2;
    else j++;
  }
  return text.length;
}

// Index just past the `}` closing an interpolation hole that starts at `i` (after its `{`).
function skipHole(text: string, i: number): number {
  let depth = 0;
  let j = i;
  while (j < text.length) {
    const c = text[j]!;
    if (c === "\"") j = skipString(text, j);
    else if (c === "'") {
      j++;
      while (j < text.length && text[j] !== "'" && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      j++;
    } else if (c === "{") {
      depth++;
      j++;
    } else if (c === "}") {
      if (depth === 0) return j + 1;
      depth--;
      j++;
    } else j++;
  }
  return text.length;
}

// Comments out (`//`, `///`, `/* */`), string and character literals kept: a name in a string may be a reflective use
// (`nameof`, `Type.GetType("X")`, a DI registration). Every string kind is skipped whole (see `skipString`), so a `//` in
// one, interpolated holes included, is no comment.
export function stripCSharpComments(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];
    if (c === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
    } else if (c === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      const stop = end < 0 ? text.length : end + 2;
      // Newlines stay, so line numbers still match the file.
      out += ` ${text.slice(i, stop).replace(/[^\n]/gu, "")}`;
      i = stop;
    } else if (c === "\"") {
      const stop = skipString(text, i);
      out += text.slice(i, stop);
      i = stop;
    } else if (c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== "\n") j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

// name -> file -> count (a private member is judged within the files of its type, every other one across the scan).
type Counts = Map<string, Map<string, number>>;

function bump(counts: Counts, name: string, file: string): void {
  let byFile = counts.get(name);
  if (!byFile) counts.set(name, byFile = new Map());
  byFile.set(file, (byFile.get(file) ?? 0) + 1);
}

// The file a member is declared in: a `partial` type's shared node can be reached from every declaring file, so the
// Declaration's `file` may be another part. The id (`file:<path>:function:<line>:…`) names the real one.
const realFile = (declaration: Declaration): string => /^file:(.+?):(?:function|field|class|interface):\d+:/u.exec(declaration.id)?.[1] ?? declaration.file;

// A static, non-generic `Main` returning `void`, `int`, `Task` or `Task<int>` that takes nothing or one `string[]`: what the
// runtime runs (the entrypoints contributor applies the same rule to the graph). `window` starts at the member's first line.
function isEntryMainSignature(window: string): boolean {
  const match = /([^;{}=]*?)\bMain\s*\(([^)]*)\)/u.exec(window);
  if (!match || !/\bstatic\b/u.test(match[1]!)) return false;
  const returnType = /(\S+)\s*$/u.exec(match[1]!.trim())?.[1]?.replace(/^global::/u, "").replace(/^System\.(?:Threading\.Tasks\.)?/u, "") ?? "";
  if (!/^(?:void|int|Int32|Task|Task<(?:int|Int32)>)$/u.test(returnType)) return false;
  const parameters = match[2]!.trim();
  return parameters === "" || /^(?:string|String|System\.String)\s*\[\s*\]\s+[\p{L}_@][\p{L}\p{N}_]*$/u.test(parameters);
}

// What a member's header says: `override`, `virtual`, `abstract`, `explicit` (`void IFoo.Bar()`), `extension` (a `this T x`
// parameter). The header runs from the member's first line (attributes included) to the line with its name.
function modifiersOf(lines: readonly string[], declaration: Declaration): ReadonlySet<string> {
  const found = new Set<string>();
  const start = (declaration.line ?? 1) - 1;
  const name = declaration.name.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  const at = new RegExp(`(?<![\\p{L}\\p{N}_])${name}(?![\\p{L}\\p{N}_])`, "u");
  const explicit = new RegExp(`[\\p{L}\\p{N}_>]\\s*\\.\\s*${name}\\s*(?:[({<]|=>)`, "u");
  let header = "";
  for (let i = start; i < Math.min(lines.length, start + 12); i++) {
    header += `${lines[i]}\n`;
    if (at.test(lines[i]!)) {
      if (explicit.test(lines[i]!)) found.add("explicit");
      break;
    }
  }
  for (const word of ["override", "virtual", "abstract"]) if (new RegExp(`\\b${word}\\b`, "u").test(header)) found.add(word);
  if (/\bthis\s+[\p{L}_]/u.test(header)) found.add("extension");
  if (declaration.name === "Main" && isEntryMainSignature(lines.slice(start, start + 12).join("\n"))) found.add("entryMain");
  return found;
}

// Members the language binds by name, never by a written call: `foreach` (GetEnumerator, MoveNext, Current, Reset),
// deconstruction (Deconstruct), `await` (GetAwaiter, GetResult, IsCompleted, OnCompleted, UnsafeOnCompleted), `using`
// (Dispose, DisposeAsync), collection initializers (Add), `fixed` (GetPinnableReference), indices and ranges (Slice, Length,
// Count), LINQ query expressions (Select, SelectMany, Where, OrderBy, OrderByDescending, ThenBy, ThenByDescending, GroupBy,
// Join, GroupJoin, Cast) and the `object` members (Equals, GetHashCode, ToString) that code reaches through the base type.
// A public, internal or protected method or property of such a name is never reported; a private one is judged normally.
export const DUCK_TYPED_MEMBERS: ReadonlySet<string> = new Set([
  "GetEnumerator", "MoveNext", "Current", "Reset", "Deconstruct",
  "GetAwaiter", "GetResult", "IsCompleted", "OnCompleted", "UnsafeOnCompleted",
  "Dispose", "DisposeAsync", "Add", "GetPinnableReference", "Slice", "Length", "Count",
  "Select", "SelectMany", "Where", "OrderBy", "OrderByDescending", "ThenBy", "ThenByDescending", "GroupBy", "Join", "GroupJoin", "Cast",
  "Equals", "GetHashCode", "ToString",
]);

const IDENTIFIER = /[\p{L}_][\p{L}\p{N}_]*/gu;

// `class A<T> : Base, IFoo<T>, IBar where T : class` -> A: [Base, IFoo, IBar].
const TYPE_HEADER = /\b(?:class|struct|record(?:\s+(?:class|struct))?)\s+([\p{L}_][\p{L}\p{N}_]*)\s*(?:<[^>{;]*>)?\s*(?:\([^)]*\))?\s*:\s*([^{;]*)/gu;

// C#, one assembly (the scan; projects come in Phase 45): public, internal, protected and private types, methods,
// properties, fields, constants and events are judged. A member is used when its name is written anywhere beside its
// declaration (private: in the files of its type; any other: in any scanned file, tests included). Names stand for the
// graph's call edges here: overloads, same-named members and uses in strings keep a declaration from being reported,
// never the other way round, and a call edge from another file counts as a use too.
export const csharpUnusedRules: IUnusedExportRules = {
  id: "csharp",
  languages: ["csharp"],
  supports: isCSharpFile,
  usesAnnotations: true,
  // Types, methods, properties, fields, constants and events. Constructors, destructors, operators, conversions,
  // accessors, indexers, enum constants and record components are never judged; neither are tests. The session
  // skips overrides, virtual and abstract members (another assembly may call them through the base) and explicit
  // interface implementations, which it reads from the member's own source lines.
  judges: (declaration) => ["class", "interface", "enum", "method", "field"].includes(declaration.kind)
    && !/[$<~]/u.test(declaration.name)
    && !declaration.testKind
    && (declaration.kind === "method" ? declaration.nodeKind === "method"
      : declaration.kind === "field" ? ["field", "constant", "property", "event"].includes(declaration.nodeKind ?? "")
        : true),
  async createSession(context) {
    const counts: Counts = new Map();
    // `Name(` that is no `new Name(`, no `.Name(` and no type header (`record Name(int A)`, whose primary constructor is no
    // separate use): a constructor's own declaration, for types.
    const constructors: Counts = new Map();
    const baseTypes = new Map<string, string[]>();
    const genericTypes = new Set<string>();
    let sources = 0;
    // The members of each file (a member's real file, not a `partial` type's first), whose modifiers are read from the source.
    const wanted = new Map<string, Declaration[]>();
    for (const declaration of context.declarations) {
      if (declaration.kind !== "method" && declaration.kind !== "field") continue;
      const file = realFile(declaration);
      wanted.set(file, [...wanted.get(file) ?? [], declaration]);
    }
    const modifiers = new Map<string, ReadonlySet<string>>();
    await context.forEachSource(isCSharpFile, (file, text) => {
      sources++;
      const code = stripCSharpComments(text);
      const members = wanted.get(file);
      if (members) {
        const lines = code.split("\n");
        for (const member of members) modifiers.set(member.id, modifiersOf(lines, member));
      }
      for (const [name] of code.matchAll(IDENTIFIER)) bump(counts, name, file);
      for (const match of code.matchAll(/(?<!\b(?:new|class|struct|record|interface)\s+)(?<![\p{L}\p{N}_.])(\p{Lu}[\p{L}\p{N}_]*)\s*\(/gu)) bump(constructors, match[1]!, file);
      for (const match of code.matchAll(/\b(?:class|struct|record(?:\s+(?:class|struct))?|interface)\s+([\p{L}_][\p{L}\p{N}_]*)\s*</gu)) genericTypes.add(match[1]!);
      for (const match of code.matchAll(TYPE_HEADER)) {
        const bases = match[2]!.split(/\bwhere\b/u)[0]!.split(",").map((base) => base.trim().replace(/<.*$/su, "").replace(/^.*\./u, "")).filter(Boolean);
        baseTypes.set(match[1]!, [...baseTypes.get(match[1]!) ?? [], ...bases]);
      }
    });

    const scannedInterfaces = new Set(context.declarations.filter((declaration) => declaration.kind === "interface").map((declaration) => declaration.name));
    // A type that lists an interface the scan does not declare (`IDisposable`, `IComparable<T>`): its public members may
    // implement it, which the graph cannot tell.
    const implementsExternal = (typeName: string | null) => (typeName ? baseTypes.get(typeName) ?? [] : []).some((base) => /^I\p{Lu}/u.test(base) && !scannedInterfaces.has(base));
    // A type declared in more than one file (`partial`): the files of all its members.
    const typeFiles = new Map<string, Set<string>>();
    // Types that hold an entrypoint `Main` (static, valid signature, non-generic): an instance `Main` is an ordinary method.
    const mainHolders = new Set<string>();
    // Static classes that hold extension methods: `2.Double()` never names `IntExt`.
    const extensionMethods = new Map<string, Declaration[]>();
    const hasModifier = (declaration: Declaration, modifier: string) => modifiers.get(declaration.id)?.has(modifier) === true;
    for (const declaration of context.declarations) {
      if (declaration.className) {
        const files = typeFiles.get(declaration.className) ?? new Set<string>();
        files.add(realFile(declaration));
        typeFiles.set(declaration.className, files);
        if (declaration.kind === "method" && hasModifier(declaration, "entryMain") && !genericTypes.has(declaration.className)) mainHolders.add(declaration.className);
        if (hasModifier(declaration, "extension")) extensionMethods.set(declaration.className, [...extensionMethods.get(declaration.className) ?? [], declaration]);
      }
    }
    const sum = (byFile: Map<string, number> | undefined, files: ReadonlySet<string> | null) => {
      if (!byFile) return 0;
      let total = 0;
      for (const [file, count] of byFile) if (files === null || files.has(file)) total += count;
      return total;
    };

    const isMentioned = (declaration: Declaration): boolean => {
      // Nothing to read (no repository path): never judge on names alone.
      if (sources === 0) return true;
      // Any attribute (`[Obsolete]`, `[Marker]`, `[JsonProperty]`, `[HttpGet]`, `[Fact]`) means a framework or a reader may use it.
      if (context.annotationsOf(declaration.id).length > 0) return true;
      if (["override", "virtual", "abstract", "explicit"].some((modifier) => hasModifier(declaration, modifier))) return true;
      const isType = declaration.kind === "class" || declaration.kind === "interface" || declaration.kind === "enum";
      const isPrivate = declaration.visibility === "private" || declaration.visibility === "private protected";
      if (!isType && !isPrivate && DUCK_TYPED_MEMBERS.has(declaration.name)) return true;
      if (isType && mainHolders.has(declaration.name)) return true;
      if (!isType && declaration.visibility !== "private" && implementsExternal(declaration.className)) return true;
      const files = isPrivate && declaration.className ? typeFiles.get(declaration.className) ?? new Set([realFile(declaration)]) : null;
      let mentions = sum(counts.get(declaration.name), files);
      if (isType) mentions -= sum(constructors.get(declaration.name), files);
      // `[Marker]` names `MarkerAttribute`.
      if (isType && declaration.name.endsWith("Attribute") && declaration.name.length > "Attribute".length) {
        mentions += sum(counts.get(declaration.name.slice(0, -"Attribute".length)), files);
      }
      return mentions > 1;
    };

    return {
      isMentionedElsewhere(declaration) {
        if (isMentioned(declaration)) return true;
        // A static class is used through any of its extension methods.
        return (declaration.kind === "class") && (extensionMethods.get(declaration.name) ?? []).some(isMentioned);
      },
    };
  },
  note: "C#: public, internal, protected and private types, methods, properties, fields, constants and events count as used when their name is written elsewhere in the scan (private members: in the files of their type), or when another file calls or references them; the scan is one assembly, so a public member nothing in it uses is reported even though a consumer outside the repository might; overrides, virtual and abstract members, explicit and external-interface implementations, attributed members and types (a framework may read them), duck-typed members the language binds by name (GetEnumerator, Dispose, LINQ operators, ...), tests, constructors, operators, accessors, indexers, enum constants, record components, types holding Main and top-level statements are skipped, and reflection or uses outside the repository are not seen.",
};

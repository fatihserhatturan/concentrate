import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { MAX_PARSED_BYTES } from "../../languages/plain/parser.js";
import { isSecretKey, redactValue } from "../java/config-files.js";

// .NET configuration files (`appsettings.json`, `appsettings.<Environment>.json`) as flat key entries, the .NET way
// Spring's `application*.yml` is read for Java (`java/config-files.ts`): the shared input of the config track, which
// makes the ConfigValue nodes, and of every reader that needs a key's value (an HttpClient `BaseAddress` in
// `Services:Orders:BaseUrl`, a connection string).
//
//   - A key is the colon path the `IConfiguration` API uses: `{"Logging": {"LogLevel": {"Default": "Info"}}}` is
//     `Logging:LogLevel:Default`; an array item is its index (`Servers:0:Host`); an object or array itself is no entry,
//     only its leaves are (an empty object / array is a leaf with the value `{}` / `[]`; `null` is the value `null`).
//     `entry.line` is the line of the leaf's key in the file (1-based), the id of the ConfigValue is
//     `<file id>:config:<line>:<key>` as Java's.
//   - The file's environment is the middle part of its name: `appsettings.Production.json` is `Production`,
//     `appsettings.json` is null. The files are read for a scan with C# files or a `.csproj`; any `.json` file named so,
//     anywhere in the repository (a `bin/` or `obj/` copy included: those are not scanned anyway).
//   - JSON as .NET reads it: comments (`//`, `/* */`) and trailing commas are allowed. A file that is not valid JSON
//     yields no entries (it is not guessed at).
//   - Keys are compared as .NET does: case-insensitively (`canonicalKey`), `:` and `__` are the same separator, so the
//     environment variable `Services__Orders__BaseUrl` overrides `Services:Orders:BaseUrl` (`keyToEnvName`,
//     `envNameToKey`). The value of a key with a secret-named segment (password, secret, token, credential, api/access/
//     private/secret/signing key; `isSecretKey` of Java, applied to the dotted form) is shown as `<redacted>`, and the
//     password of a URL's userinfo or a `Password=` connection-string parameter (`redactValue`; `Server=a;Password=x`
//     too) is too: `shownValue(entry)` is the one rule for what may be shown.
//   - `lookup(key, { environment, near })` is the best entry of a key: of the wanted environment first, then the
//     environment-less ones, then the others by path; among files the closest to `near` (a source file's relative
//     path: same directory or an ancestor). `entriesFor(key, { below })` lists every entry of the key (and, with
//     `below`, of its subtree: what `GetSection("A")` and `IOptions<T>` bound to a section read).

export type AppSettingEntry = {
  /** Colon path as written: `Logging:LogLevel:Default`, `Servers:0:Host`. */
  key: string;
  /** Case-folded colon path (`canonicalKey`). */
  canonical: string;
  /** The leaf's value as text: strings as is, numbers / booleans as written, `null`, `{}` and `[]`. */
  value: string;
  /** `string`, `number`, `boolean`, `null`, `object` (an empty object) or `array` (an empty array). */
  valueType: "string" | "number" | "boolean" | "null" | "object" | "array";
  /** Relative path, `/`-separated. */
  file: string;
  line: number;
  /** `Production` for `appsettings.Production.json`; null for `appsettings.json`. */
  environment: string | null;
};

export type AppSettingsLookup = {
  /** Wanted environment (`Production`): its entries win over the environment-less ones. */
  environment?: string | string[];
  /** Relative path of the file asking: entries of the closest directory win. */
  near?: string;
  /** Also the entries below the key (`A` matches `A:B:C`). */
  below?: boolean;
};

export type AppSettings = {
  entries: readonly AppSettingEntry[];
  /** Relative paths of the files read. */
  files: readonly string[];
  /** The best entry of `key` (any case, `:` or `__`), or null. */
  lookup(key: string, options?: AppSettingsLookup): AppSettingEntry | null;
  /** Every entry of `key` (and below it with `below`), best first. */
  entriesFor(key: string, options?: AppSettingsLookup): AppSettingEntry[];
};

const NAME = /^appsettings(?:\.([^./\\]+))?\.json$/iu;

/** `Production` / null for an appsettings file path (`appsettings.json` is null), undefined when the path is no appsettings file. */
export function appSettingsEnvironment(relativePath: string): string | null | undefined {
  const match = NAME.exec(path.posix.basename(relativePath.split(path.sep).join("/")));
  if (!match) return undefined;
  return match[1] ?? null;
}

export const isAppSettingsFile = (relativePath: string): boolean => appSettingsEnvironment(relativePath) !== undefined;

/** Whether a scan holds a C# project: a `.cs` file or a `.csproj` / `.sln` / `.slnx` / `.fsproj`. */
export const hasCSharpProject = (files: readonly string[]): boolean => files.some((file) => /\.(?:cs|csproj|sln|slnx)$/iu.test(file));

// ---------------------------------------------------------------- key forms

/** The key as .NET compares it: lower case with `:` separators (`Services__Orders:BaseUrl` is `services:orders:baseurl`). */
export const canonicalKey = (key: string): string => key.replace(/__/gu, ":").replace(/:+/gu, ":").replace(/^:|:$/gu, "").toLowerCase();

/** The environment variable that overrides a key: `Services:Orders:BaseUrl` is `Services__Orders__BaseUrl`. */
export const keyToEnvName = (key: string): string => key.replace(/:/gu, "__");

/** The key an environment variable name stands for (the double underscore is the separator): `Services__Orders__BaseUrl` is `Services:Orders:BaseUrl`. */
export const envNameToKey = (name: string): string => name.replace(/__/gu, ":");

/** Whether a name holds the `__` separator, so it is an override of a hierarchical key (and not a plain variable). */
export const isHierarchicalEnvName = (name: string): boolean => /[A-Za-z0-9]__[A-Za-z0-9]/u.test(name);

/** The last segments of a colon key joined as the .NET `GetSection("A").GetSection("B")` path: `join("A", "B:C")` is `A:B:C`. */
export const joinKey = (...parts: ReadonlyArray<string | null | undefined>): string => parts.filter((part): part is string => part !== null && part !== undefined && part !== "").join(":");

/** The value to show for an entry: redacted for a secret key and for credentials in a URL or connection string. */
export const shownValue = (entry: Pick<AppSettingEntry, "key" | "value">): string => shownConfigValue(entry.key, entry.value);

export function shownConfigValue(key: string, value: string): string {
  const dotted = key.replace(/:/gu, ".");
  if (isSecretKey(dotted)) return value === "" ? value : "<redacted>";
  // Connection strings: `Password=x;` / `Pwd=x` (case-insensitive) after `;` or at the start.
  return redactValue(dotted, value).replace(/((?:^|;)\s*(?:password|pwd)\s*=)([^;]*)/giu, (_match, head: string, secret: string) => `${head}${secret === "" ? "" : "<redacted>"}`);
}

// ---------------------------------------------------------------- reading JSON with lines

type Json = { kind: "object"; members: Array<{ key: string; line: number; value: Json }> } | { kind: "array"; items: Json[]; line: number } | { kind: "scalar"; type: AppSettingEntry["valueType"]; text: string; line: number };

class Reader {
  private index = 0;
  private line = 1;
  constructor(private readonly text: string) {}

  fail(): never {
    throw new SyntaxError("invalid JSON");
  }

  private skip(): void {
    for (;;) {
      const char = this.text[this.index];
      if (char === "\n") {
        this.line += 1;
        this.index += 1;
      } else if (char === " " || char === "\t" || char === "\r" || char === "﻿") this.index += 1;
      else if (char === "/" && this.text[this.index + 1] === "/") {
        while (this.index < this.text.length && this.text[this.index] !== "\n") this.index += 1;
      } else if (char === "/" && this.text[this.index + 1] === "*") {
        const end = this.text.indexOf("*/", this.index + 2);
        if (end === -1) this.fail();
        for (let i = this.index; i < end; i += 1) if (this.text[i] === "\n") this.line += 1;
        this.index = end + 2;
      } else return;
    }
  }

  private string(): string {
    const start = this.index;
    this.index += 1;
    while (this.index < this.text.length) {
      const char = this.text[this.index]!;
      if (char === "\\") this.index += 2;
      else if (char === '"') {
        this.index += 1;
        return JSON.parse(this.text.slice(start, this.index)) as string;
      } else {
        if (char === "\n") this.fail();
        this.index += 1;
      }
    }
    return this.fail();
  }

  value(depth = 0): Json {
    this.skip();
    if (depth > 100) this.fail();
    const char = this.text[this.index];
    const line = this.line;
    if (char === "{") {
      this.index += 1;
      const members: Array<{ key: string; line: number; value: Json }> = [];
      for (;;) {
        this.skip();
        if (this.text[this.index] === "}") {
          this.index += 1;
          return { kind: "object", members };
        }
        if (this.text[this.index] !== '"') this.fail();
        const keyLine = this.line;
        const key = this.string();
        this.skip();
        if (this.text[this.index] !== ":") this.fail();
        this.index += 1;
        members.push({ key, line: keyLine, value: this.value(depth + 1) });
        this.skip();
        if (this.text[this.index] === ",") this.index += 1;
        else if (this.text[this.index] !== "}") this.fail();
      }
    }
    if (char === "[") {
      this.index += 1;
      const items: Json[] = [];
      for (;;) {
        this.skip();
        if (this.text[this.index] === "]") {
          this.index += 1;
          return { kind: "array", items, line };
        }
        items.push(this.value(depth + 1));
        this.skip();
        if (this.text[this.index] === ",") this.index += 1;
        else if (this.text[this.index] !== "]") this.fail();
      }
    }
    if (char === '"') return { kind: "scalar", type: "string", text: this.string(), line };
    const literal = /^(?:true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/u.exec(this.text.slice(this.index, this.index + 64));
    if (!literal) return this.fail();
    this.index += literal[0].length;
    const type = literal[0] === "null" ? "null" : literal[0] === "true" || literal[0] === "false" ? "boolean" : "number";
    return { kind: "scalar", type, text: literal[0], line };
  }

  end(): void {
    this.skip();
    if (this.index < this.text.length) this.fail();
  }
}

/** The leaves of a JSON document (comments and trailing commas allowed) as colon-key entries with their key's line; null when it is not JSON or not an object. */
export function flattenJsonSettings(text: string): Array<{ key: string; value: string; valueType: AppSettingEntry["valueType"]; line: number }> | null {
  const reader = new Reader(text);
  let root: Json;
  try {
    root = reader.value();
    reader.end();
  } catch {
    return null;
  }
  if (root.kind !== "object") return null;
  const entries: Array<{ key: string; value: string; valueType: AppSettingEntry["valueType"]; line: number }> = [];
  const visit = (node: Json, key: string, line: number): void => {
    if (node.kind === "scalar") entries.push({ key, value: node.text, valueType: node.type, line });
    else if (node.kind === "object") {
      if (node.members.length === 0 && key !== "") entries.push({ key, value: "{}", valueType: "object", line });
      for (const member of node.members) visit(member.value, key === "" ? member.key : `${key}:${member.key}`, member.line);
    } else {
      if (node.items.length === 0) entries.push({ key, value: "[]", valueType: "array", line });
      node.items.forEach((item, index) => visit(item, `${key}:${index}`, line));
    }
  };
  visit(root, "", 1);
  return entries;
}

// ---------------------------------------------------------------- the config of a scan

const depthFrom = (near: string, file: string): number => {
  // 0: same directory; larger: an ancestor directory (farther); Infinity: not an ancestor.
  const nearDir = path.posix.dirname(near);
  const fileDir = path.posix.dirname(file);
  if (nearDir === fileDir) return 0;
  if (fileDir === "." ) return nearDir.split("/").length;
  return nearDir.startsWith(`${fileDir}/`) ? nearDir.split("/").length - fileDir.split("/").length : Number.POSITIVE_INFINITY;
};

function createSettings(entries: AppSettingEntry[], files: string[]): AppSettings {
  const byCanonical = new Map<string, AppSettingEntry[]>();
  for (const entry of entries) {
    const list = byCanonical.get(entry.canonical);
    if (list) list.push(entry);
    else byCanonical.set(entry.canonical, [entry]);
  }
  const rank = (entry: AppSettingEntry, options: AppSettingsLookup): [number, number, string, number] => {
    const wanted = options.environment === undefined ? [] : Array.isArray(options.environment) ? options.environment : [options.environment];
    const environment = entry.environment === null ? 1 : wanted.some((name) => name.toLowerCase() === entry.environment!.toLowerCase()) ? 0 : 2;
    return [environment, options.near ? depthFrom(options.near, entry.file) : 0, entry.file, entry.line];
  };
  const compare = (options: AppSettingsLookup) => (a: AppSettingEntry, b: AppSettingEntry): number => {
    const left = rank(a, options);
    const right = rank(b, options);
    return left[0] - right[0] || left[1] - right[1] || left[2].localeCompare(right[2]) || left[3] - right[3];
  };
  const entriesFor = (key: string, options: AppSettingsLookup = {}): AppSettingEntry[] => {
    const wanted = canonicalKey(key);
    const found = options.below
      ? entries.filter((entry) => entry.canonical === wanted || entry.canonical.startsWith(`${wanted}:`))
      : byCanonical.get(wanted) ?? [];
    return [...found].sort(compare(options));
  };
  return { entries, files, entriesFor, lookup: (key, options = {}) => entriesFor(key, { ...options, below: false })[0] ?? null };
}

/** Settings over entries built by hand, for tests and for callers that already hold the entries. */
export function appSettingsOf(entries: readonly AppSettingEntry[]): AppSettings {
  return createSettings([...entries], [...new Set(entries.map((entry) => entry.file))]);
}

const cache = new Map<string, { signature: string; settings: AppSettings }>();

/**
 * The appsettings files among `files` (absolute paths of the scan) as one `AppSettings`, read once per root and kept
 * while the files are unchanged (path, size, modification time), so the config and HTTP contributors share one read.
 * Entries are in path order. No entries (and no read) for a scan without C# files or a project file.
 */
export async function readAppSettings(rootPath: string, files: readonly string[]): Promise<AppSettings> {
  if (!hasCSharpProject(files)) return appSettingsOf([]);
  const found: Array<{ absolute: string; relative: string; environment: string | null }> = [];
  for (const absolute of files) {
    const relative = path.relative(rootPath, absolute).split(path.sep).join("/");
    const environment = appSettingsEnvironment(relative);
    if (environment !== undefined) found.push({ absolute, relative, environment });
  }
  found.sort((a, b) => a.relative.localeCompare(b.relative));
  const stats = await Promise.all(found.map((file) => stat(file.absolute).then((info) => `${file.relative}:${info.size}:${info.mtimeMs}`, () => `${file.relative}:missing`)));
  const signature = stats.join("\n");
  const cached = cache.get(rootPath);
  if (cached?.signature === signature) return cached.settings;
  const entries: AppSettingEntry[] = [];
  for (const file of found) {
    const info = await stat(file.absolute).catch(() => null);
    if (!info || info.size > MAX_PARSED_BYTES) continue;
    const text = await readFile(file.absolute, "utf8").catch(() => null);
    const flat = text === null ? null : flattenJsonSettings(text);
    if (!flat) continue;
    for (const item of flat) entries.push({ key: item.key, canonical: canonicalKey(item.key), value: item.value, valueType: item.valueType, file: file.relative, line: item.line, environment: file.environment });
  }
  const settings = createSettings(entries, found.map((file) => file.relative));
  cache.set(rootPath, { signature, settings });
  return settings;
}

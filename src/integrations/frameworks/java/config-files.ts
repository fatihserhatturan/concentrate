import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { asMap, readYamlDocuments, type YValue } from "../scripts/yaml.js";

// Spring configuration files and the property keys they hold, shared by the config/env and HTTP readers
// (a `${api.url}` base URL needs the value of the key).
//
// Files: `application.properties`, `application.yml` / `.yaml`, their profile variants
// (`application-dev.yml`) and `bootstrap.*`, in a directory named `resources` (`src/main/resources`,
// `src/test/resources`, a module's own) or its `config` directory, and in a `config` directory (or one of its
// subdirectories, `config/*/`) at a module or repository root outside `src` (where Spring Boot also looks).
// Entries of `src/test/resources` are visible to test readers only (a `near` outside the test source set
// does not see them). Config is read only for a scan with Java files or a Maven/Gradle build file
// (`readScanConfig`). The profile of a file is the one in its
// name; a YAML document (multi-document files are read whole, `---` separated) can narrow itself with
// `spring.config.activate.on-profile` (or the older `spring.profiles`), which wins for its keys.
//
// Entries: YAML is flattened to dotted keys (`a.b.c`; a list item is `a[0]`, `a[0].b`; a flow or block
// scalar is the key's value, `null` an empty value), properties files keep their keys. Each entry has the
// key as written, the file (relative, `/`-separated) and the line of the key. Keys are compared the way
// Spring binds them (relaxed binding): `myApp.api-url`, `my_app.apiUrl` and `MYAPP.APIURL` are one key.
// A YAML file with syntax errors yields no entries (it is not guessed at).
//
// Values are looked up by `lookup(key, { profile, near })`: an entry of the profile first, then those of
// no profile, then the others in file order; among files the one in the resources directory closest to
// `near` (a source file's relative path) wins. `resolveText` fills `${key}` / `${key:default}`
// placeholders from the entries (nested placeholders and placeholders whose value has placeholders too, with
// a cycle stopping at eight levels) and lists the names it could not fill: not a key, so a candidate for an
// environment variable (`${PORT}`). A placeholder whose key is named like a secret (`isSecretKey`) is never
// filled, whatever the entries or its default hold: it stays `${key}`. `redactValue` is the one rule for
// what a shown value may reveal.

export type ConfigEntry = {
  /** Dotted key as written in the file: `spring.datasource.url`, `servers[0].host`. */
  key: string;
  /** Relaxed-binding form (`canonicalKey`). */
  canonical: string;
  value: string;
  /** Relative path, `/`-separated. */
  file: string;
  line: number;
  /** The profile expression the entry applies to (`dev`, `prod | staging`); null when it always does. */
  profile: string | null;
  format: "properties" | "yaml";
};

export type ConfigLookupOptions = {
  /** Wanted profile: its entries win over the profile-less ones. */
  profile?: string | string[];
  /** Relative path of the file asking: entries of the closest resources directory win. */
  near?: string;
};

export type SpringConfig = {
  entries: readonly ConfigEntry[];
  /** Relative paths of the config files read. */
  files: readonly string[];
  /** The best entry of `key` (any spelling), or null. */
  lookup(key: string, options?: ConfigLookupOptions): ConfigEntry | null;
  /** Every entry of `key`, best first. */
  all(key: string, options?: ConfigLookupOptions): ConfigEntry[];
  /** Entries whose key is `prefix` or below it (`app.api` → `app.api.url`, `app.api.servers[0]`), in file order. */
  withPrefix(prefix: string, options?: ConfigLookupOptions): ConfigEntry[];
  /** Profiles `spring.profiles.active` names in the profile-less entries. */
  activeProfiles(): string[];
  /** `text` with its placeholders filled; `unresolved` the keys no entry has (nothing when all were). */
  resolveText(text: string, options?: ConfigLookupOptions): { value: string; unresolved: string[] };
};

// ---------------------------------------------------------------- file names

const CONFIG_NAME = /^(application|bootstrap)(?:-([^/]+))?\.(properties|ya?ml)$/u;

/**
 * The profile of a Spring config file name, `null` for the default (`application.yml`), or `undefined` when
 * the path is no Spring config file: `src/main/resources/application-dev.properties` is `dev`.
 */
export function springConfigProfile(relativePath: string): string | null | undefined {
  const posix = relativePath.split(path.sep).join("/");
  const match = CONFIG_NAME.exec(path.posix.basename(posix));
  if (!match) return undefined;
  const directory = path.posix.dirname(posix);
  const parent = path.posix.basename(directory);
  if (parent === "resources" || (parent === "config" && path.posix.basename(path.posix.dirname(directory)) === "resources")) return match[2] ?? null;
  // `config/` and `config/<profile dir>/` at a module or repository root: not inside a source tree.
  const root = parent === "config" ? path.posix.dirname(directory) : path.posix.basename(path.posix.dirname(directory)) === "config" ? path.posix.dirname(path.posix.dirname(directory)) : null;
  if (root !== null && !/(?:^|\/)(?:src|node_modules)(?:\/|$)/u.test(root)) return match[2] ?? null;
  return undefined;
}

/** Whether a relative path is in a test source set (`src/test/...`): its config is for test readers. */
export const isTestSourcePath = (relativePath: string): boolean => /(?:^|\/)src\/test\//u.test(relativePath.split(path.sep).join("/"));

/** Whether a scan holds a Java project: a `.java` file or a Maven / Gradle build file. */
export function hasJavaProject(files: readonly string[]): boolean {
  return files.some((file) => /\.java$/u.test(file) || /(?:^|[\\/])(?:pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?)$/u.test(file));
}

const SECRET_WORDS = new Set(["password", "passwd", "pwd", "secret", "secrets", "credential", "credentials", "token", "apikey", "privatekey", "accesskey", "secretkey", "encryptionkey", "signingkey"]);
const SECRET_PAIRS = new Set(["private key", "api key", "access key", "secret key", "encryption key", "signing key", "client secret"]);

/**
 * Whether a config key names a secret: some segment of it (split on `.`) has, among its whole parts (kebab,
 * snake and camel case, lower-cased), password, passwd, pwd, secret(s), credential(s) or a singular token, or
 * two parts that make private-key, api-key, access-key, secret-key, encryption-key, signing-key or
 * client-secret. A plain `key` is no secret (`cache.key-prefix`), nor are `max-tokens` or `passage`.
 */
export function isSecretKey(key: string): boolean {
  return key.split(".").some((segment) => {
    const name = segment.replace(/\[[^\]]*\]/gu, "");
    const parts = name.replace(/([a-z\d])([A-Z])/gu, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2").toLowerCase().split(/[-_\s]+/u).filter((part) => part !== "");
    return parts.some((part, index) => SECRET_WORDS.has(part) || (index > 0 && SECRET_PAIRS.has(`${parts[index - 1]} ${part}`)));
  });
}

const PURE_PLACEHOLDER = /^\$\{[^}:]*\}$/u;

/**
 * A config value as it may be shown: `<redacted>` for the value of a secret key unless it is only a
 * placeholder without a default (`${DB_PASSWORD}`); in any value, the password of a URL's userinfo
 * (`scheme://user:pw@host`) and a `password=` parameter (`jdbc:…;password=pw`, `?password=pw`).
 */
export function redactValue(key: string, value: string): string {
  if (value === "") return value;
  if (isSecretKey(key)) return PURE_PLACEHOLDER.test(value) ? value : "<redacted>";
  const keep = (secret: string): string => (PURE_PLACEHOLDER.test(secret) ? secret : "<redacted>");
  return value
    .replace(/((?:[a-z][a-z0-9+.-]*:)+\/\/[^/\s:@?#]*:)([^@/\s]*)(@)/giu, (_match, head: string, secret: string, at: string) => `${head}${keep(secret)}${at}`)
    .replace(/([?;&,](?:password|passwd|pwd)=)([^&;,\s]*)/giu, (_match, head: string, secret: string) => `${head}${keep(secret)}`);
}

export const isSpringConfigFile = (relativePath: string): boolean => springConfigProfile(relativePath) !== undefined;

// The directory of the module a path belongs to: what precedes `src/main` or `src/test` (`a` for
// `a/src/main/resources/application.yml`, "" at the root), else the path's own directory.
function moduleOf(relativePath: string): string {
  const posix = relativePath.split(path.sep).join("/");
  const match = /^(?:(.*?)\/)?src\/(?:main|test)\//u.exec(posix);
  if (match) return match[1] ?? "";
  const directory = path.posix.dirname(posix);
  return directory === "." ? "" : directory;
}

// ---------------------------------------------------------------- relaxed binding

/**
 * Spring's canonical form of a property key: lower-case kebab, segments joined by `.`
 * (`myApp.API_URL` is `my-app.api-url`); list indexes `[0]` are kept.
 */
export function canonicalKey(key: string): string {
  return key.split(".").map((segment) => {
    const bracket = /^(.*?)((?:\[[^\]]*\])*)$/u.exec(segment)!;
    const name = bracket[1]!
      .replace(/([a-z\d])([A-Z])/gu, "$1-$2")
      .replace(/([A-Z]+)([A-Z][a-z])/gu, "$1-$2")
      .replace(/_/gu, "-")
      .replace(/-+/gu, "-")
      .toLowerCase();
    return `${name}${bracket[2]}`;
  }).join(".");
}

/** What `lookup` compares: the canonical key without dashes (`my-app.api-url` and `myapp.apiurl` meet). */
export const looseKey = (key: string): string => canonicalKey(key).replace(/-/gu, "");

/** The environment variable that overrides a key: `my-app.api-url` and `servers[0].host` are `MYAPP_APIURL` and `SERVERS_0_HOST`. */
export function keyToEnvName(key: string): string {
  return canonicalKey(key).replace(/\[(\d+)\]/gu, "_$1_").replace(/[.-]/gu, (char) => (char === "." ? "_" : "")).replace(/_+/gu, "_").replace(/^_|_$/gu, "").toUpperCase();
}

/** The key an environment variable name stands for: `MY_APP_URL` is `my.app.url`, `SERVERS_0_HOST` is `servers[0].host`. */
export function envNameToKey(name: string): string {
  return name.toLowerCase().replace(/_(\d+)(?=_|$)/gu, "[$1]").replace(/_/gu, ".").replace(/\.\[/gu, "[");
}

// ---------------------------------------------------------------- placeholders

/** A `${key:default}` of a value: both are parts again (`${a.${b}:${c}}`). */
export type PlaceholderPart = { text: string } | { key: PlaceholderPart[]; default: PlaceholderPart[] | null };

/** Splits a value into its text and `${key}` / `${key:default}` placeholders; nested ones are parsed; an unclosed `${` is text. */
export function parsePlaceholders(text: string): PlaceholderPart[] {
  const parse = (start: number, until: ReadonlySet<string>): { parts: PlaceholderPart[]; end: number } => {
    const parts: PlaceholderPart[] = [];
    let literal = "";
    let i = start;
    while (i < text.length) {
      const char = text[i]!;
      if (until.has(char)) break;
      if (char === "$" && text[i + 1] === "{") {
        const inner = parseInner(i + 2);
        if (inner) {
          if (literal) parts.push({ text: literal });
          literal = "";
          parts.push(inner.part);
          i = inner.end;
          continue;
        }
      }
      literal += char;
      i += 1;
    }
    if (literal) parts.push({ text: literal });
    return { parts, end: i };
  };
  // `parseInner` depends only on where it starts: memoized, failures too, so an unclosed `${${${` stays linear.
  const inners = new Map<number, { part: PlaceholderPart; end: number } | null>();
  const parseInner = (start: number): { part: PlaceholderPart; end: number } | null => {
    if (inners.has(start)) return inners.get(start)!;
    inners.set(start, null);
    const result = readInner(start);
    inners.set(start, result);
    return result;
  };
  const readInner = (start: number): { part: PlaceholderPart; end: number } | null => {
    if (text.indexOf("}", start) === -1) return null;
    const key = parse(start, new Set([":", "}"]));
    let position = key.end;
    let fallback: PlaceholderPart[] | null = null;
    if (text[position] === ":") {
      const second = parse(position + 1, new Set(["}"]));
      fallback = second.parts;
      position = second.end;
    }
    return text[position] === "}" ? { part: { key: key.parts, default: fallback }, end: position + 1 } : null;
  };
  return parse(0, new Set()).parts;
}

const isText = (parts: readonly PlaceholderPart[]): string | null => (parts.every((part) => "text" in part) ? parts.map((part) => ("text" in part ? part.text : "")).join("") : null);

/** The literal keys of the placeholders of a value, nested ones included (a key that is itself a placeholder is left out). */
export function placeholderKeys(text: string): string[] {
  const keys: string[] = [];
  const visit = (parts: readonly PlaceholderPart[]) => {
    for (const part of parts) {
      if ("text" in part) continue;
      const literal = isText(part.key);
      if (literal !== null) keys.push(literal.trim());
      visit(part.key);
      if (part.default) visit(part.default);
    }
  };
  visit(parsePlaceholders(text));
  return keys;
}

/** `text` with each placeholder replaced by `lookup(key)` (else its default, else left as written); `unresolved` the keys with neither. */
export function resolvePlaceholders(text: string, lookup: (key: string) => string | null | undefined): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const render = (parts: readonly PlaceholderPart[]): string => parts.map((part) => {
    if ("text" in part) return part.text;
    const key = render(part.key).trim();
    const found = lookup(key);
    if (found !== null && found !== undefined) return found;
    if (part.default) return render(part.default);
    unresolved.push(key);
    return `\${${key}}`;
  }).join("");
  return { value: render(parsePlaceholders(text)), unresolved };
}

// ---------------------------------------------------------------- reading

export type ParsedProperty = { key: string; value: string; line: number };

// `\uXXXX`, `\n`, `\t`, `\\`, `\:`, `\=`, `\ ` in a properties key or value.
function unescapeProperty(text: string): string {
  return text.replace(/\\(u[0-9a-fA-F]{4}|[\s\S])/gu, (_match, code: string) => {
    if (code.startsWith("u") && code.length === 5) return String.fromCharCode(parseInt(code.slice(1), 16));
    return ({ n: "\n", t: "\t", r: "\r", f: "\f" } as Record<string, string>)[code] ?? code;
  });
}

/** A `.properties` file: `key=value`, `key:value`, `key value`; `#` and `!` comments; a trailing `\` continues the line. */
export function parseProperties(text: string): ParsedProperty[] {
  const entries: ParsedProperty[] = [];
  const lines = text.replace(/^﻿/u, "").split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const first = lines[index]!.replace(/^[ \t\f]+/u, "");
    if (first === "" || first.startsWith("#") || first.startsWith("!")) continue;
    let logical = first;
    const startLine = index + 1;
    // A line ends in a continuation when it has an odd number of trailing backslashes.
    while (/(?:^|[^\\])(?:\\\\)*\\$/u.test(logical) && index + 1 < lines.length) {
      index += 1;
      logical = `${logical.slice(0, -1)}${lines[index]!.replace(/^[ \t\f]+/u, "")}`;
    }
    let split = -1;
    for (let i = 0; i < logical.length; i += 1) {
      const char = logical[i]!;
      if (char === "\\") i += 1;
      else if (char === "=" || char === ":" || char === " " || char === "\t" || char === "\f") {
        split = i;
        break;
      }
    }
    const rawKey = split === -1 ? logical : logical.slice(0, split);
    let rest = split === -1 ? "" : logical.slice(split);
    rest = rest.replace(/^[ \t\f]*[=:]?[ \t\f]*/u, "");
    const key = unescapeProperty(rawKey);
    if (key !== "") entries.push({ key, value: unescapeProperty(rest.replace(/[ \t\f]+$/u, "")), line: startLine });
  }
  return entries;
}

type Flat = { key: string; value: string; line: number };

// A YAML value as dotted keys; a scalar is the value of its key, an empty map or list nothing.
function flatten(value: YValue, prefix: string, line: number, out: Flat[]): void {
  if (value === null) {
    if (prefix) out.push({ key: prefix, value: "", line });
    return;
  }
  if (value.type === "scalar") {
    if (prefix) out.push({ key: prefix, value: value.text === "~" || value.text === "null" ? "" : value.text, line: value.line });
    return;
  }
  if (value.type === "map") {
    for (const entry of value.entries) flatten(entry.value, prefix ? `${prefix}.${entry.key}` : entry.key, entry.line, out);
    return;
  }
  value.items.forEach((item, index) => flatten(item.value, `${prefix}[${index}]`, item.line, out));
}

/** The dotted keys of every document of a YAML text, with the profile the document names (`spring.config.activate.on-profile`, `spring.profiles`); null for a text with syntax errors. */
export async function flattenYamlDocuments(text: string): Promise<Array<{ profile: string | null; entries: Flat[] }> | null> {
  const documents = await readYamlDocuments(text);
  if (!documents) return null;
  const result: Array<{ profile: string | null; entries: Flat[] }> = [];
  for (const document of documents) {
    if (!asMap(document)) continue;
    const entries: Flat[] = [];
    flatten(document, "", 0, entries);
    let profile: string | null = null;
    const kept = entries.filter((entry) => {
      if (entry.key === "spring.config.activate.on-profile" || entry.key === "spring.profiles") {
        profile ??= entry.value;
        return false;
      }
      if (/^spring\.profiles\[\d+\]$/u.test(entry.key) || /^spring\.config\.activate\.on-profile\[\d+\]$/u.test(entry.key)) {
        profile = profile ? `${profile} | ${entry.value}` : entry.value;
        return false;
      }
      return true;
    });
    result.push({ profile, entries: kept });
  }
  return result;
}

/** Whether a profile expression (`dev`, `a | b`, `a, b`, `!prod`, `a & b`) holds for the active profiles. */
export function profileMatches(expression: string | null, active: readonly string[]): boolean {
  if (expression === null) return true;
  const set = new Set(active);
  return expression.split(/[|,]/u).some((alternative) => alternative.split("&").every((term) => {
    const name = term.trim();
    return name.startsWith("!") ? !set.has(name.slice(1).trim()) : set.has(name);
  }));
}

// ---------------------------------------------------------------- the config of a scan

function createConfig(entries: ConfigEntry[], files: string[]): SpringConfig {
  const byKey = new Map<string, ConfigEntry[]>();
  for (const entry of entries) {
    const key = looseKey(entry.key);
    byKey.set(key, [...byKey.get(key) ?? [], entry]);
  }
  const rank = (entry: ConfigEntry, options: ConfigLookupOptions | undefined): [number, number] => {
    const wanted = options?.profile === undefined ? [] : Array.isArray(options.profile) ? options.profile : [options.profile];
    const profileRank = entry.profile !== null && wanted.length > 0 && profileMatches(entry.profile, wanted) ? 0 : entry.profile === null ? 1 : 2;
    let distance = 0;
    if (options?.near) {
      // The same module first, then by how much of the module path the two share.
      const nearModule = moduleOf(options.near);
      const entryModule = moduleOf(entry.file);
      if (nearModule !== entryModule) distance = 1 + nearModule.split("/").length - sharedPrefix(nearModule, entryModule);
    }
    return [profileRank, distance];
  };
  const sorted = (list: readonly ConfigEntry[], options: ConfigLookupOptions | undefined): ConfigEntry[] => {
    const order = new Map(list.map((entry, index) => [entry, index]));
    return [...list].sort((left, right) => {
      const a = rank(left, options);
      const b = rank(right, options);
      return a[0] - b[0] || a[1] - b[1] || order.get(left)! - order.get(right)!;
    });
  };
  // Entries of the test source set are for readers in it; with no reader (`near`) everything is visible.
  const visible = (entry: ConfigEntry, options: ConfigLookupOptions | undefined): boolean => !options?.near || isTestSourcePath(options.near) || !isTestSourcePath(entry.file);
  const all = (key: string, options?: ConfigLookupOptions) => sorted((byKey.get(looseKey(key)) ?? []).filter((entry) => visible(entry, options)), options);
  const lookup = (key: string, options?: ConfigLookupOptions) => all(key, options)[0] ?? null;
  const active = (): string[] => {
    const value = lookup("spring.profiles.active")?.value;
    const indexed = entries.filter((entry) => entry.profile === null && /^spring\.profiles\.active\[\d+\]$/u.test(entry.key)).map((entry) => entry.value);
    return [...(value ? value.split(",") : []), ...indexed].map((profile) => profile.trim()).filter((profile) => profile !== "");
  };
  return {
    entries,
    files,
    lookup,
    all,
    withPrefix(prefix, options) {
      const wanted = canonicalKey(prefix).replace(/-/gu, "");
      const matching = entries.filter((entry) => {
        if (!visible(entry, options)) return false;
        const key = looseKey(entry.key);
        return key === wanted || key.startsWith(`${wanted}.`) || key.startsWith(`${wanted}[`);
      });
      // One entry per key: the best of its spellings.
      const seen = new Set<string>();
      return sorted(matching, options).filter((entry) => !seen.has(looseKey(entry.key)) && seen.add(looseKey(entry.key))).sort((left, right) => entries.indexOf(left) - entries.indexOf(right));
    },
    activeProfiles: active,
    resolveText(text, options) {
      const unresolved: string[] = [];
      const fill = (source: string, depth: number, seen: ReadonlySet<string>): string => {
        const { value, unresolved: missing } = resolvePlaceholders(source, (key) => {
          // A secret's placeholder stays as written.
          if (isSecretKey(key)) return `\${${key}}`;
          const entry = lookup(key, options);
          if (!entry) return null;
          const loose = looseKey(key);
          if (depth >= 8 || seen.has(loose)) return null;
          return fill(entry.value, depth + 1, new Set([...seen, loose]));
        });
        unresolved.push(...missing);
        return value;
      };
      const value = fill(text, 0, new Set());
      return { value, unresolved: [...new Set(unresolved)] };
    },
  };
}

function sharedPrefix(left: string, right: string): number {
  const a = left.split("/");
  const b = right.split("/");
  let count = 0;
  while (count < a.length && count < b.length && a[count] === b[count]) count += 1;
  return count;
}

const relativePath = (rootPath: string, file: string): string => path.relative(rootPath, file).split(path.sep).join("/");

const configs = new Map<string, { signature: string; config: Promise<SpringConfig> }>();

async function readConfig(rootPath: string, found: Array<{ absolute: string; relative: string; profile: string | null }>): Promise<SpringConfig> {
  const entries: ConfigEntry[] = [];
  for (const file of found) {
    const text = await readFile(file.absolute, "utf8").catch(() => null);
    if (text === null) continue;
    if (/\.properties$/u.test(file.relative)) {
      for (const property of parseProperties(text)) {
        entries.push({ key: property.key, canonical: canonicalKey(property.key), value: property.value, file: file.relative, line: property.line, profile: file.profile, format: "properties" });
      }
      continue;
    }
    for (const document of await flattenYamlDocuments(text) ?? []) {
      for (const entry of document.entries) {
        entries.push({ key: entry.key, canonical: canonicalKey(entry.key), value: entry.value, file: file.relative, line: entry.line, profile: document.profile ?? file.profile, format: "yaml" });
      }
    }
  }
  return createConfig(entries, found.map((file) => file.relative));
}

/**
 * The Spring config of the scan: every config file among `files` (absolute paths the scan discovered),
 * read once per root and kept while the files are unchanged (path, size and modification time), so the
 * config/env and HTTP contributors share one read. Files are in path order.
 */
export async function readSpringConfig(rootPath: string, files: readonly string[]): Promise<SpringConfig> {
  const found: Array<{ absolute: string; relative: string; profile: string | null }> = [];
  for (const absolute of files) {
    const relative = relativePath(rootPath, absolute);
    const profile = springConfigProfile(relative);
    if (profile !== undefined) found.push({ absolute, relative, profile });
  }
  found.sort((left, right) => left.relative.localeCompare(right.relative));
  const stats = await Promise.all(found.map((file) => stat(file.absolute).then((info) => `${file.relative}:${info.size}:${info.mtimeMs}`, () => `${file.relative}:missing`)));
  const signature = stats.join("\n");
  const cached = configs.get(rootPath);
  if (cached?.signature === signature) return cached.config;
  const config = readConfig(rootPath, found);
  configs.set(rootPath, { signature, config });
  return config;
}

/** `readSpringConfig` for a scan with Java files or a build file; no entries (not even a read) for any other scan. */
export async function readScanConfig(rootPath: string, files: readonly string[]): Promise<SpringConfig> {
  return hasJavaProject(files) ? readSpringConfig(rootPath, files) : springConfigOf([]);
}

/** A config over entries built by hand, for tests and for callers that already hold the entries. */
export function springConfigOf(entries: readonly ConfigEntry[]): SpringConfig {
  return createConfig([...entries], [...new Set(entries.map((entry) => entry.file))]);
}

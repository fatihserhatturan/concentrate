import { readFile } from "node:fs/promises";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import type { JavaParsePlugin } from "../../languages/java/parser.js";
import { compactExpression, normalizeJavaType } from "../../languages/java/syntax.js";
import { createJavaTypeIndex, type JavaType, type JavaTypeIndex } from "../../languages/java/types.js";
import { isEnvFile, parseEnvFile } from "../js-ts/env-files.js";
import { annotationValue, findAnnotations, javaAnnotationReader, type JavaAnnotationInfo } from "./annotations.js";
import { keyToEnvName, looseKey, parsePlaceholders, readSpringConfig, type ConfigEntry, type PlaceholderPart, type SpringConfig } from "./config-files.js";
import { createJavaReceiverResolver } from "./receivers.js";
import { javaMethods, type JavaMethod } from "./shared.js";
import { createJavaStringResolver, hasLiteralText, readJavaString, readLocalStrings, type JavaStringTemplate } from "./strings.js";

// Java config and environment (Phase 42, track C).
//
// Env reads, as USES_ENV from the method that reads (the file for a field initializer or an initializer
// block) and from the file, to an EnvVar (`env:NAME`, as every language makes it; `access` is the call):
//   - `System.getenv("NAME")` (`System.getenv`) and `System.getenv().get("NAME")` / `.getOrDefault(…)`, also
//     through a local bound to `System.getenv()` (`System.getenv().get`); a static import of `getenv`;
//   - the name may be a constant (`EnvKeys.REGION`, `PREFIX + "TOKEN"`: `createJavaStringResolver`);
//   - `System.getProperty` is a JVM property, not the environment: ignored.
//
// Spring config files (`application*.properties|yml|yaml`, `bootstrap*`; `readSpringConfig`): every key of
// every file is a ConfigValue `{name: key, value, valueType, line}` declared by that file (DECLARES_CONFIG;
// id `<file id>:config:<line>:<key>` as the JS/TS config values have). A key of a profile file is its own
// node in that file (`application-prod.properties`), never merged with the default one, so the file says
// the profile. The value of a key named like a secret (password, secret, token, key, credential) is
// `<redacted>` unless it is only a placeholder (`${DB_PASSWORD}`). `${NAME}` / `${NAME:default}`
// placeholders of a value that name no key and look like an environment variable are USES_ENV from the
// config file.
//
// Config reads, as CONSUMES_CONFIG (to every file's node of the key) from the reader, its file and the
// routes the reader handles:
//   - `@Value("${key}")` / `@Value("${key:default}")` of `org.springframework.beans.factory.annotation` (and
//     Micronaut's `io.micronaut.context.annotation`; `@Property(name = "key")`): on a parameter the method or
//     constructor is the reader; on a method (a setter) the method; on a field the methods of the class
//     (inner classes too) that read the field by name (`name`, `this.name`; not a local or parameter of
//     the same name), and always the file. SpEL `#{…}` and plain literals are no reads. A literal key
//     (or a constant) with several placeholders reads each;
//   - `@ConfigurationProperties(prefix = "app.mail")` (Spring Boot and Micronaut) on a class, or on a `@Bean`
//     method (the returned class): the fields of the class (its supertypes, nested classes and records
//     too, with relaxed binding: `fromAddress` is `from-address`) are bound to the keys under the prefix;
//     the class's file and a `@Bean` method read them. A method that calls an accessor (`getHost()`,
//     `isEnabled()`, `host()`, `setHost`) on a value typed with the properties class (a field, parameter or
//     local) reads the keys of that field and below; one that is given the class and calls no accessor on
//     it (not a constructor) reads all keys. Injection (INJECTS) is not needed: the receiver types see
//     the field a constructor stored;
//   - `environment.getProperty("key")` / `getRequiredProperty("key")` on Spring's or Micronaut's `Environment`
//     / `PropertyResolver` (the receiver type, `createJavaReceiverResolver`): the calling method.
// A key no scanned file defines but with a default (`${key:default}`, `getProperty("key", "default")`) is a
// ConfigValue of the reader's file with `valueType: "default"`. A key with neither that looks like an
// environment variable (`${REGION}`, `getProperty("SPRING_TOKEN")`) is USES_ENV from the reader and its file
// (`@Value`, `Environment.getProperty`); a placeholder with a default is both.
//
// Relaxed binding: a read of `app.mail.port` is also USES_ENV of `APP_MAIL_PORT` (`keyToEnvName`,
// access `spring relaxed binding`) when that variable is declared in a `.env*` file, read by `System.getenv`
// or named by a placeholder anywhere in the scan: Spring would let it override the key; unknown names are
// not guessed (every key would otherwise bring an EnvVar nobody mentions).
//
// The contributor runs before `js-ts.env-config` and `js-ts.env-files` (route USES_ENV from the handler's
// reads and the EnvVar declarations of `.env` files are theirs). The HTTP track reads the same keys
// through `config-files.ts`, not through this file.
//
// Not handled: SpEL (`#{…}`), `@Value` of a constant that is no literal, `@PropertySource` and
// `@EnableConfigurationProperties` / `@ConfigurationPropertiesScan` (a properties class counts through its own
// annotation), constructor binding names from `@Name`, `Binder.get(…)`, MicroProfile `@ConfigProperty`,
// `System.getProperty`, `Environment.getProperty` in a field initializer, `ConfigurableEnvironment`
// property sources, a `Map<String, Nested>` / `List<Nested>` field's element type (the field binds all
// keys under it), a key built at run time, and profile activation (every profile's file is a node).

type CallFact = {
  /** Line and column of the invocation (the Call node's `line` and `columnNumber`). */
  l: number;
  c: number;
  /** Id of the Function that holds it, null at file level. */
  f: string | null;
  a: "getenv" | "getenv-map" | "property";
  k: JavaStringTemplate;
  /** Literal second argument (`getProperty("k", "default")`). */
  d?: string;
};
type FileFacts = { calls: CallFact[]; reads: Record<string, string[]> };

const FACTS = "javaConfigEnv";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const ENV_LIKE = /^[A-Z][A-Z0-9_]*$/u;
const MAP_READS = new Set(["get", "getOrDefault"]);
const PROPERTY_READS = new Set(["getProperty", "getRequiredProperty"]);
const VALUE_PACKAGES = ["org.springframework.beans.factory.annotation", "io.micronaut.context.annotation"];
const PROPERTIES_PACKAGES = ["org.springframework.boot.context.properties", "io.micronaut.context.annotation"];
const BEAN_PACKAGES = ["org.springframework.context.annotation", "io.micronaut.context.annotation"];
const ENVIRONMENTS = [
  "org.springframework.core.env.Environment",
  "org.springframework.core.env.ConfigurableEnvironment",
  "org.springframework.core.env.PropertyResolver",
  "org.springframework.core.env.ConfigurablePropertyResolver",
  "org.springframework.core.env.AbstractEnvironment",
  "org.springframework.core.env.StandardEnvironment",
  "io.micronaut.context.env.Environment",
  "io.micronaut.context.env.PropertyResolver",
];
const SECRET_KEY = /(?:password|passwd|secret|token|credential|api-?key|private-?key|access-?key)/iu;

const isComment = (node: SyntaxNode) => node.type.endsWith("comment");
const argumentsOf = (call: SyntaxNode): SyntaxNode[] => call.childForFieldName("arguments")?.namedChildren.filter((child) => !isComment(child)) ?? [];

// ---------------------------------------------------------------- parse time

// `System.getenv`: the object is `System` (or `java.lang.System`).
function isSystem(object: SyntaxNode | null): boolean {
  const text = object ? compactExpression(object.text) : "";
  return text === "System" || text === "java.lang.System";
}

function contains(outer: SyntaxNode, inner: SyntaxNode): boolean {
  return outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;
}

/**
 * What only the syntax tells: the key argument of each `getenv`, `getenv().get` and `getProperty` call, as a
 * string template (`javaStringConstantsPlugin`'s constants are resolved later), and which fields of the
 * file that carry `@Value` / `@Property` each method reads. Kept on the File node (`javaConfigEnv`) until the
 * contributor has used it.
 */
const readConfigEnv: JavaParsePlugin = ({ fileNodeId, root, nodes, relationships, functions }) => {
  const text = root.text;
  const hasGetenv = /\bgetenv\b/u.test(text);
  const hasProperty = /\b(?:getProperty|getRequiredProperty)\b/u.test(text);
  // Fields annotated with a value annotation: the names a method may read.
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const annotated = new Set<string>();
  for (const rel of relationships) {
    if (rel.type !== ("FIELD_HAS_DECORATOR" as GraphRelationship["type"])) continue;
    if (!/^(?:[\w.]*\.)?(?:Value|Property)$/u.test(String(byId.get(rel.to)?.properties.name ?? ""))) continue;
    const name = byId.get(rel.from)?.properties.name;
    if (typeof name === "string") annotated.add(name);
  }
  if (!hasGetenv && !hasProperty && annotated.size === 0) return;
  const file = nodes.find((node) => node.id === fileNodeId);
  if (!file) return;
  const staticGetenv = /\bimport\s+static\s+java\.lang\.System\.(?:getenv|\*)\s*;/u.test(text);

  const owners = [...functions];
  const innermost = (node: SyntaxNode) => owners.filter((fn) => contains(fn.syntax, node)).sort((a, b) => (a.syntax.endIndex - a.syntax.startIndex) - (b.syntax.endIndex - b.syntax.startIndex))[0];
  const locals = new Map<string, Map<string, JavaStringTemplate>>();
  const localsOf = (fnId: string, syntax: SyntaxNode) => {
    let known = locals.get(fnId);
    if (!known) locals.set(fnId, (known = readLocalStrings([syntax])));
    return known;
  };
  // Locals bound to `System.getenv()`, by function.
  const aliases = new Map<string, Set<string>>();
  const aliasesOf = (fnId: string, syntax: SyntaxNode): Set<string> => {
    let known = aliases.get(fnId);
    if (known) return known;
    known = new Set();
    const stack: SyntaxNode[] = [syntax];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === "local_variable_declaration") {
        for (const declarator of node.childrenForFieldName("declarator")) {
          const value = declarator.childForFieldName("value");
          const name = declarator.childForFieldName("name")?.text;
          if (name && value && isGetenvMap(value)) known.add(name);
        }
      }
      stack.push(...node.namedChildren);
    }
    aliases.set(fnId, known);
    return known;
  };
  const isGetenvMap = (node: SyntaxNode): boolean =>
    node.type === "method_invocation" && node.childForFieldName("name")?.text === "getenv" && argumentsOf(node).length === 0 && (isSystem(node.childForFieldName("object")) || (!node.childForFieldName("object") && staticGetenv));

  const calls: CallFact[] = [];
  const reads = new Map<string, Set<string>>();
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    stack.push(...node.namedChildren.filter((child) => !isComment(child)));
    if (node.type === "method_invocation") {
      const name = node.childForFieldName("name")?.text ?? "";
      const object = node.childForFieldName("object");
      const args = argumentsOf(node);
      let api: CallFact["a"] | null = null;
      const owner = innermost(node);
      if (name === "getenv" && args.length >= 1 && (isSystem(object) || (!object && staticGetenv))) api = "getenv";
      else if (MAP_READS.has(name) && object && args.length >= 1) {
        if (isGetenvMap(object) || (object.type === "identifier" && owner && aliasesOf(owner.node.id, owner.syntax).has(object.text))) api = "getenv-map";
      } else if (PROPERTY_READS.has(name) && object && args.length >= 1) api = "property";
      if (!api || !args[0]) continue;
      const key = readJavaString(args[0], owner ? { locals: localsOf(owner.node.id, owner.syntax) } : {});
      if (!key) continue;
      const fact: CallFact = { l: node.startPosition.row + 1, c: node.startPosition.column, f: owner?.node.id ?? null, a: api, k: key };
      if (api === "property" && args[1]) {
        const second = readJavaString(args[1]);
        if (second && second.every((part) => "text" in part)) fact.d = second.map((part) => ("text" in part ? part.text : "")).join("");
      }
      calls.push(fact);
      continue;
    }
    if (annotated.size === 0 || node.type !== "identifier" || !annotated.has(node.text)) continue;
    const parent = node.parent;
    if (!parent) continue;
    if (parent.type === "method_invocation" && parent.childForFieldName("name")?.id === node.id) continue;
    if (parent.type === "field_access") {
      if (parent.childForFieldName("field")?.id !== node.id || parent.childForFieldName("object")?.text !== "this") continue;
    } else if (parent.type === "variable_declarator" || parent.type === "formal_parameter" || parent.type === "spread_parameter") {
      continue;
    }
    const owner = innermost(node);
    if (!owner) continue;
    // A parameter or local of the same name hides the field (`this.name` does not care).
    const shadowed = parent.type !== "field_access" && owner.node.properties.javaLocals !== undefined && node.text in (safeParse(owner.node.properties.javaLocals) ?? {});
    if (shadowed) continue;
    const set = reads.get(owner.node.id) ?? new Set<string>();
    set.add(node.text);
    reads.set(owner.node.id, set);
  }
  if (calls.length === 0 && reads.size === 0) return;
  const facts: FileFacts = { calls, reads: Object.fromEntries([...reads].map(([id, set]) => [id, [...set].sort()])) };
  file.properties[FACTS] = JSON.stringify(facts);
};

function safeParse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export const javaConfigEnvPlugin: JavaParsePlugin & { version: string } = Object.assign(readConfigEnv, { version: "1" });

// ---------------------------------------------------------------- contributor

type Use = {
  /** Function that reads; null for the file alone. */
  fnId: string | null;
  fileId: string;
  key: string;
  /** `${key:default}`: the default text. */
  def: string | null;
  /** The key and the keys below it (a bound field) instead of the key and its list items. */
  below: boolean;
  line: number;
  access: string;
  localName: string;
};

function literalOf(parts: readonly PlaceholderPart[]): string | null {
  return parts.every((part) => "text" in part) ? parts.map((part) => ("text" in part ? part.text : "")).join("") : null;
}

// `${a:x}` placeholders of an annotation text with literal keys, nested ones included.
function placeholdersOf(text: string): Array<{ key: string; def: string | null }> {
  const found: Array<{ key: string; def: string | null }> = [];
  const visit = (parts: readonly PlaceholderPart[]) => {
    for (const part of parts) {
      if ("text" in part) continue;
      const key = literalOf(part.key);
      if (key !== null && key.trim() !== "") found.push({ key: key.trim(), def: part.default ? literalOf(part.default) : null });
      visit(part.key);
      if (part.default) visit(part.default);
    }
  };
  visit(parsePlaceholders(text));
  return found;
}

const typeNameOf = (value: unknown): string | null => (typeof value === "string" ? normalizeJavaType(value) : null);

type Parameter = { name: string; type: string; annotations?: Array<{ name: string; args: string[] }> };
function parametersOf(fn: GraphNode): Parameter[] {
  try {
    const parsed: unknown = JSON.parse(String(fn.properties.parameters ?? "[]"));
    return Array.isArray(parsed) ? (parsed as Parameter[]) : [];
  } catch {
    return [];
  }
}

const valueTypeOf = (value: string): string => (/^(?:true|false)$/iu.test(value) ? "boolean" : /^-?\d+(?:\.\d+)?$/u.test(value) ? "number" : "string");

function shownValue(entry: ConfigEntry): string {
  if (!SECRET_KEY.test(entry.key.split(".").at(-1) ?? "") || entry.value === "") return entry.value;
  return /^\$\{[^}]*\}$/u.test(entry.value) ? entry.value : "<redacted>";
}

const configValueId = (fileId: string, line: number, key: string): string => `${fileId}:config:${line}:${key}`;

export const javaConfigEnvContributor: ISemanticContributor = {
  id: "java.config-env",
  version: "1",
  async contribute(graph, rootPath, _report, files) {
    // Facts of the parse, read once and removed (they are not graph properties).
    const facts = new Map<string, FileFacts>();
    for (const file of graph.nodesWithLabel("File")) {
      const parsed = safeParse(file.properties[FACTS]);
      if (parsed) facts.set(file.id, parsed as unknown as FileFacts);
      delete file.properties[FACTS];
    }
    const config = await readSpringConfig(rootPath, files);
    const methods = javaMethods(graph);
    if (methods.length === 0 && config.entries.length === 0) return;
    await new Builder(graph, rootPath, files, config, methods, facts).run();
  },
};

class Builder {
  private readonly types: JavaTypeIndex;
  private readonly fileByPath = new Map<string, string>();
  private readonly relationshipKeys = new Set<string>();
  private readonly cvByEntry = new Map<ConfigEntry, string>();
  private readonly consumed = new Map<string, Map<string, string>>();
  private readonly envs = new Set<string>();
  private readonly uses: Use[] = [];
  private readonly envUses: Array<{ fnId: string | null; fileId: string; name: string; line: number; access: string }> = [];
  private readonly methodById = new Map<string, JavaMethod>();
  private readonly fieldsByType = new Map<string, GraphNode[]>();
  private readonly loose = new Map<ConfigEntry, string>();

  constructor(
    private readonly graph: IGraphContributor,
    private readonly rootPath: string,
    private readonly files: readonly string[],
    private readonly config: SpringConfig,
    private readonly methods: readonly JavaMethod[],
    private readonly facts: ReadonlyMap<string, FileFacts>,
  ) {
    this.types = createJavaTypeIndex(graph, createResolutionRelationshipIndex(graph));
    for (const file of graph.nodesWithLabel("File")) {
      if (typeof file.properties.relativePath === "string") this.fileByPath.set(file.properties.relativePath.split("\\").join("/"), file.id);
    }
    for (const method of methods) this.methodById.set(method.node.id, method);
    for (const rel of graph.relationshipsOfType("DEFINES_FIELD")) {
      const field = graph.node(rel.to);
      if (!field) continue;
      const list = this.fieldsByType.get(rel.from) ?? [];
      list.push(field);
      this.fieldsByType.set(rel.from, list);
    }
    for (const entry of config.entries) this.loose.set(entry, looseKey(entry.key));
    for (const env of graph.nodesWithLabel("EnvVar")) this.envs.add(env.id);
  }

  async run(): Promise<void> {
    await this.loadEnvFiles();
    this.declareConfigFiles();
    this.collectEnvReads();
    this.collectValues();
    this.collectEnvironmentReads();
    this.collectConfigurationProperties();
    this.emitUses();
  }

  // ---- emitting

  private relationship(rel: GraphRelationship): void {
    const key = `${rel.type}\0${rel.from}\0${rel.to}\0${String(rel.properties.line ?? "")}\0${String(rel.properties.access ?? rel.properties.localName ?? "")}`;
    if (this.relationshipKeys.has(key)) return;
    this.relationshipKeys.add(key);
    this.graph.addRelationship(rel);
  }

  private envVar(name: string): string {
    const id = `env:${name}`;
    if (!this.graph.node(id)) this.graph.addNode({ id, label: "EnvVar", properties: { name } });
    return id;
  }

  private useEnv(fnId: string | null, fileId: string, name: string, line: number, access: string): void {
    const to = this.envVar(name);
    for (const from of fnId ? [fnId, fileId] : [fileId]) this.relationship({ from, to, type: "USES_ENV", properties: { line, access } });
  }

  private consume(fnId: string | null, fileId: string, cvId: string, localName: string): void {
    for (const from of fnId ? [fnId, fileId] : [fileId]) this.relationship({ from, to: cvId, type: "CONSUMES_CONFIG", properties: { localName } });
    if (fnId) {
      const own = this.consumed.get(fnId) ?? new Map<string, string>();
      if (!own.has(cvId)) own.set(cvId, localName);
      this.consumed.set(fnId, own);
    }
  }

  // ---- config files

  private declareConfigFiles(): void {
    const known = new Set<string>();
    for (const entry of this.config.entries) {
      const fileId = this.fileByPath.get(entry.file);
      if (!fileId) continue;
      const id = configValueId(fileId, entry.line, entry.key);
      this.cvByEntry.set(entry, id);
      if (known.has(id)) continue;
      known.add(id);
      this.graph.addNode({ id, label: "ConfigValue", properties: { name: entry.key, value: shownValue(entry), valueType: valueTypeOf(entry.value), line: entry.line } });
      this.relationship({ from: fileId, to: id, type: "DECLARES_CONFIG", properties: {} });
      // A `${NAME}` the config does not define is read from the environment.
      for (const key of new Set(placeholderTexts(entry.value))) {
        if (this.entriesFor(key, false).length > 0 || !ENV_LIKE.test(key)) continue;
        this.envUses.push({ fnId: null, fileId, name: key, line: entry.line, access: "config placeholder" });
      }
    }
  }

  // The entries of every file for `key` (relaxed binding) and, for a list, its items; `below`: all keys under it.
  private entriesFor(key: string, below: boolean): ConfigEntry[] {
    const wanted = looseKey(key);
    return this.config.entries.filter((entry) => {
      const loose = this.loose.get(entry)!;
      return loose === wanted || loose.startsWith(`${wanted}[`) || (below && loose.startsWith(`${wanted}.`));
    });
  }

  // ---- env reads

  private scopeOf(fnId: string | null, fileId: string, line: number): { fileId: string; typeId?: string | null; fnLine?: number } {
    const method = fnId ? this.methodById.get(fnId) : undefined;
    if (method) return { fileId, typeId: method.owner.id, fnLine: Number(method.node.properties.line) };
    // A field initializer: the innermost type of the file around the line.
    const inFile = this.types.types.filter((type) => type.fileId === fileId && Number(type.node.properties.line) <= line && line <= Number(type.node.properties.endLine ?? Infinity));
    inFile.sort((a, b) => Number(b.node.properties.line) - Number(a.node.properties.line));
    return { fileId, typeId: inFile[0]?.id ?? null };
  }

  private literalKey(template: JavaStringTemplate, scope: { fileId: string; typeId?: string | null; fnLine?: number }): string | null {
    const parts = createJavaStringResolver(this.graph).resolveParts(template, scope);
    return parts.length > 0 && parts.every((part) => "text" in part) && hasLiteralText(parts) ? parts.map((part) => ("text" in part ? part.text : "")).join("") : null;
  }

  private collectEnvReads(): void {
    for (const [fileId, fileFacts] of this.facts) {
      for (const call of fileFacts.calls) {
        if (call.a === "property") continue;
        const name = this.literalKey(call.k, this.scopeOf(call.f, fileId, call.l));
        if (name === null || !ENV_NAME.test(name)) continue;
        this.envUses.push({ fnId: call.f, fileId, name, line: call.l, access: call.a === "getenv" ? "System.getenv" : "System.getenv().get" });
      }
    }
  }

  // ---- @Value and @Property

  private collectValues(): void {
    const reader = javaAnnotationReader(this.graph);
    const fileOfType = new Map<string, string>();
    for (const type of this.types.types) fileOfType.set(type.id, type.fileId);
    const readsByFn = new Map<string, Set<string>>();
    for (const fileFacts of this.facts.values()) for (const [fnId, names] of Object.entries(fileFacts.reads)) readsByFn.set(fnId, new Set(names));

    // Fields: the class's methods that read it, and the file.
    for (const type of this.types.types) {
      for (const field of this.fieldsByType.get(type.id) ?? []) {
        for (const ann of this.valueAnnotations(reader.annotationsOf(field))) {
          const readers = this.methods.filter((method) => readsByFn.get(method.node.id)?.has(String(field.properties.name)) && this.within(method.owner.id, type.id)).map((method) => method.node.id);
          for (const key of this.keysOf(ann)) {
            const common = { fileId: type.fileId, key: key.key, def: key.def, below: false, line: ann.line, access: ann.simpleName === "Property" ? "@Property" : "@Value", localName: String(field.properties.name) };
            if (readers.length === 0) this.uses.push({ fnId: null, ...common });
            else for (const fnId of readers) this.uses.push({ fnId, ...common });
          }
        }
      }
    }
    for (const method of this.methods) {
      // A method (a setter).
      for (const ann of this.valueAnnotations(reader.annotationsOf(method.node))) {
        for (const key of this.keysOf(ann)) {
          this.uses.push({ fnId: method.node.id, fileId: method.fileId, key: key.key, def: key.def, below: false, line: ann.line, access: ann.simpleName === "Property" ? "@Property" : "@Value", localName: String(method.node.properties.name) });
        }
      }
      // Parameters.
      const infos = this.parameterAnnotations(method);
      for (const [parameter, ann] of infos) {
        for (const key of this.keysOf(ann)) {
          this.uses.push({ fnId: method.node.id, fileId: method.fileId, key: key.key, def: key.def, below: false, line: ann.line, access: ann.simpleName === "Property" ? "@Property" : "@Value", localName: parameter.name });
        }
      }
    }
  }

  // `@Value` / `@Property` among annotations, package-checked.
  private valueAnnotations(list: readonly JavaAnnotationInfo[]): JavaAnnotationInfo[] {
    return [...findAnnotations(list, "Value", VALUE_PACKAGES), ...findAnnotations(list, "Property", ["io.micronaut.context.annotation"])];
  }

  // The keys an annotation reads: `${key:default}` placeholders of `@Value`, `name` of `@Property`.
  private keysOf(ann: JavaAnnotationInfo): Array<{ key: string; def: string | null }> {
    if (ann.simpleName === "Property") {
      const name = annotationValue(ann, "name")?.find((entry) => entry.resolved)?.value;
      return name ? [{ key: name, def: null }] : [];
    }
    const text = annotationValue(ann)?.find((entry) => entry.resolved)?.value;
    if (text === undefined || text.includes("#{")) return [];
    return placeholdersOf(text);
  }

  // Parameter annotations as annotation infos, qualified the way `javaAnnotationReader` does for the others.
  private parameterAnnotations(method: JavaMethod): Array<[Parameter, JavaAnnotationInfo]> {
    const result: Array<[Parameter, JavaAnnotationInfo]> = [];
    const parameters = parametersOf(method.node).filter((parameter) => (parameter.annotations?.length ?? 0) > 0);
    if (parameters.length === 0) return result;
    const imports = this.importsOf(method.fileId);
    const namespace = typeof method.owner.properties.namespace === "string" ? method.owner.properties.namespace : "";
    const line = Number(method.node.properties.line);
    for (const parameter of parameters) {
      for (const annotation of parameter.annotations ?? []) {
        const simpleName = annotation.name.slice(annotation.name.lastIndexOf(".") + 1);
        const qualifiedName = annotation.name.includes(".") && !/^\p{Lu}/u.test(annotation.name) ? annotation.name : annotation.name.includes(".") ? null : imports.single.get(simpleName) ?? null;
        const own = qualifiedName === null && this.types.types.some((type) => type.qualifiedName === `${namespace}.${simpleName}` || (type.fileId === method.fileId && type.name === simpleName));
        const info: JavaAnnotationInfo = { name: annotation.name, simpleName, qualifiedName, args: annotation.args, line, decoratorId: "", ownType: own, wildcardImports: imports.wildcard };
        if (this.valueAnnotations([info]).length > 0) result.push([parameter, info]);
      }
    }
    return result;
  }

  private importCache = new Map<string, { single: Map<string, string>; wildcard: string[] }>();
  private importsOf(fileId: string): { single: Map<string, string>; wildcard: string[] } {
    let known = this.importCache.get(fileId);
    if (known) return known;
    known = { single: new Map(), wildcard: [] };
    for (const rel of this.graph.relationshipsOfType("IMPORTS")) {
      if (rel.from !== fileId) continue;
      const properties = this.graph.node(rel.to)?.properties;
      if (!properties || properties.isStatic === true || typeof properties.source !== "string") continue;
      if (properties.isWildcard === true) known.wildcard.push(properties.source);
      else known.single.set(properties.source.slice(properties.source.lastIndexOf(".") + 1), properties.source);
    }
    this.importCache.set(fileId, known);
    return known;
  }

  // `inner` is `outer` or nested in it.
  private within(inner: string, outer: string): boolean {
    for (let current: JavaType | null = this.types.byId.get(inner) ?? null; current; current = this.types.enclosing(current)) {
      if (current.id === outer) return true;
    }
    return false;
  }

  // ---- Environment.getProperty

  private collectEnvironmentReads(): void {
    const calls = new Map<string, GraphNode>();
    for (const rel of this.graph.relationshipsOfType("CALLS")) {
      const call = this.graph.node(rel.to);
      if (call?.label === "Call" && this.methodById.has(rel.from)) calls.set(`${rel.from}|${String(call.properties.line)}:${String(call.properties.columnNumber)}`, call);
    }
    const resolver = createJavaReceiverResolver(this.graph);
    for (const [fileId, fileFacts] of this.facts) {
      for (const fact of fileFacts.calls) {
        if (fact.a !== "property" || !fact.f) continue;
        const call = calls.get(`${fact.f}|${fact.l}:${fact.c}`);
        const method = this.methodById.get(fact.f);
        if (!call || !method) continue;
        const type = resolver.typeOfCall(call, method.node);
        const names = type ? [type.qualifiedName, ...type.candidates].filter((name): name is string => name !== null) : [];
        if (!names.some((name) => ENVIRONMENTS.includes(name))) continue;
        const key = this.literalKey(fact.k, this.scopeOf(fact.f, fileId, fact.l));
        if (key === null || key.trim() === "") continue;
        this.uses.push({ fnId: fact.f, fileId, key: key.trim(), def: fact.d ?? null, below: false, line: fact.l, access: "Environment.getProperty", localName: key.trim() });
      }
    }
  }

  // ---- @ConfigurationProperties

  private fieldsOf(type: JavaType, seen = new Set<string>()): GraphNode[] {
    if (seen.has(type.id)) return [];
    seen.add(type.id);
    const own = (this.fieldsByType.get(type.id) ?? []).filter((field) => field.properties.isStatic !== true && field.properties.fieldKind !== "constant");
    const inherited = this.types.supertypes(type).filter((parent) => !parent.isInterface).flatMap((parent) => this.fieldsOf(parent, seen));
    const names = new Set(own.map((field) => String(field.properties.name)));
    return [...own, ...inherited.filter((field) => !names.has(String(field.properties.name)))];
  }

  // The keys of a properties class: leaf fields (nested types are followed) under `prefix`, with the
  // top-level field each belongs to.
  private bindingsOf(type: JavaType, prefix: string, top: string | null, seen: ReadonlySet<string>, depth: number): Array<{ key: string; top: string; path: string }> {
    const bindings: Array<{ key: string; top: string; path: string }> = [];
    for (const field of this.fieldsOf(type)) {
      const name = String(field.properties.name);
      const key = `${prefix}.${name}`;
      const owner = top ?? name;
      const typeName = typeNameOf(field.properties.typeName);
      const nested = typeName && depth < 6 ? this.types.resolve(typeName, { fileId: type.fileId, typeId: type.id }) : null;
      const nestedKind = nested?.node.properties.kind;
      if (nested && !seen.has(nested.id) && (nestedKind === "class" || nestedKind === "record")) {
        const inner = this.bindingsOf(nested, key, owner, new Set([...seen, nested.id]), depth + 1);
        if (inner.length > 0) {
          bindings.push(...inner.map((binding) => ({ ...binding, path: `${name}.${binding.path}` })));
          continue;
        }
      }
      bindings.push({ key, top: owner, path: name });
    }
    return bindings;
  }

  private collectConfigurationProperties(): void {
    const reader = javaAnnotationReader(this.graph);
    type Properties = { type: JavaType; prefix: string; binder: JavaMethod | null; line: number; bindings: Array<{ key: string; top: string; path: string }> };
    const classes = new Map<string, Properties>();
    const prefixOf = (list: readonly JavaAnnotationInfo[]): { prefix: string; line: number } | null => {
      const ann = findAnnotations(list, "ConfigurationProperties", PROPERTIES_PACKAGES)[0];
      if (!ann) return null;
      const value = (annotationValue(ann, "prefix") ?? annotationValue(ann, "value"))?.find((entry) => entry.resolved)?.value;
      return value === undefined ? null : { prefix: value.trim().replace(/\.$/u, ""), line: ann.line };
    };
    for (const type of this.types.types) {
      if (type.isInterface) continue;
      const found = prefixOf(reader.annotationsOf(type.node));
      if (found && found.prefix !== "") classes.set(type.id, { type, prefix: found.prefix, binder: null, line: found.line, bindings: this.bindingsOf(type, found.prefix, null, new Set([type.id]), 0) });
    }
    // `@Bean @ConfigurationProperties(prefix = "…") Props props()`: the returned class, bound by the method.
    for (const method of this.methods) {
      const found = prefixOf(reader.annotationsOf(method.node));
      if (!found || found.prefix === "" || findAnnotations(reader.annotationsOf(method.node), "Bean", BEAN_PACKAGES).length === 0) continue;
      const returned = typeNameOf(method.node.properties.returnType);
      const type = returned ? this.types.resolve(returned, { fileId: method.fileId, typeId: method.owner.id }) : null;
      if (!type || classes.has(type.id)) continue;
      classes.set(type.id, { type, prefix: found.prefix, binder: method, line: found.line, bindings: this.bindingsOf(type, found.prefix, null, new Set([type.id]), 0) });
    }
    if (classes.size === 0) return;

    // The properties class (or the @Bean method) reads its keys.
    for (const properties of classes.values()) {
      for (const binding of properties.bindings) {
        this.uses.push({ fnId: properties.binder?.node.id ?? null, fileId: properties.binder?.fileId ?? properties.type.fileId, key: binding.key, def: null, below: true, line: properties.line, access: "@ConfigurationProperties", localName: binding.path });
      }
    }

    // Readers: accessor calls on a value of the class, and a method that is handed one.
    const resolver = createJavaReceiverResolver(this.graph);
    const callsByFn = new Map<string, GraphNode[]>();
    for (const rel of this.graph.relationshipsOfType("CALLS")) {
      const call = this.graph.node(rel.to);
      if (call?.label !== "Call" || call.properties.callKind !== "method" || !this.methodById.has(rel.from)) continue;
      const list = callsByFn.get(rel.from) ?? [];
      list.push(call);
      callsByFn.set(rel.from, list);
    }
    for (const method of this.methods) {
      const calls = callsByFn.get(method.node.id) ?? [];
      const viaParameter = new Set<string>();
      for (const call of calls) {
        const type = resolver.typeOfCall(call, method.node);
        const properties = type?.typeId ? classes.get(type.typeId) : undefined;
        if (!properties || properties.binder?.node.id === method.node.id) continue;
        const receiver = String(call.properties.receiver ?? "");
        viaParameter.add(receiver);
        const fieldNames = this.fieldsOf(properties.type).map((field) => String(field.properties.name));
        const field = accessorField(String(call.properties.callee), fieldNames);
        if (!field) continue;
        for (const binding of properties.bindings.filter((candidate) => candidate.top === field)) {
          this.uses.push({ fnId: method.node.id, fileId: method.fileId, key: binding.key, def: null, below: true, line: Number(call.properties.line), access: "@ConfigurationProperties", localName: binding.path });
        }
      }
      if (method.node.properties.kind === "constructor") continue;
      for (const parameter of parametersOf(method.node)) {
        const typeName = typeNameOf(parameter.type);
        const type = typeName ? this.types.resolve(typeName, { fileId: method.fileId, typeId: method.owner.id, fnLine: Number(method.node.properties.line) }) : null;
        const properties = type ? classes.get(type.id) : undefined;
        if (!properties || properties.binder?.node.id === method.node.id) continue;
        // Handed the properties and calling no accessor on them: it reads whatever they hold.
        if ([...viaParameter].some((receiver) => receiver === parameter.name || receiver.startsWith(`${parameter.name}.`))) continue;
        for (const binding of properties.bindings) {
          this.uses.push({ fnId: method.node.id, fileId: method.fileId, key: binding.key, def: null, below: true, line: Number(method.node.properties.line), access: "@ConfigurationProperties", localName: parameter.name });
        }
      }
    }
  }

  // ---- output

  private emitUses(): void {
    const entriesOf = (use: Use) => this.entriesFor(use.key, use.below);
    // Names an environment variable can have, to tell which relaxed-binding overrides are real.
    const known = new Set<string>();
    for (const env of this.envs) known.add(env.slice("env:".length));
    for (const env of this.envUses) known.add(env.name);
    for (const use of this.uses) if (ENV_LIKE.test(use.key) && entriesOf(use).length === 0) known.add(use.key);
    for (const entry of this.config.entries) for (const key of placeholderTexts(entry.value)) if (ENV_LIKE.test(key)) known.add(key);
    for (const name of this.readEnvFileNames()) known.add(name);

    for (const env of this.envUses) this.useEnv(env.fnId, env.fileId, env.name, env.line, env.access);

    for (const use of this.uses) {
      const entries = entriesOf(use);
      for (const entry of entries) {
        const id = this.cvByEntry.get(entry);
        if (id) this.consume(use.fnId, use.fileId, id, use.localName);
      }
      if (entries.length === 0 && !use.below) {
        if (use.def !== null) {
          const id = configValueId(use.fileId, use.line, use.key);
          this.graph.addNode({ id, label: "ConfigValue", properties: { name: use.key, value: use.def, valueType: "default", line: use.line } });
          this.relationship({ from: use.fileId, to: id, type: "DECLARES_CONFIG", properties: {} });
          this.consume(use.fnId, use.fileId, id, use.localName);
        }
        if (ENV_LIKE.test(use.key)) this.useEnv(use.fnId, use.fileId, use.key, use.line, use.access);
      }
      // Spring lets `APP_MAIL_PORT` override `app.mail.port`.
      const override = keyToEnvName(use.key);
      if (override !== use.key && ENV_NAME.test(override) && known.has(override)) this.useEnv(use.fnId, use.fileId, override, use.line, "spring relaxed binding");
    }

    // The routes of a reading handler read the same config (the env reads follow in `js-ts.env-config`).
    const handled = new Map<string, string[]>();
    for (const rel of this.graph.relationshipsOfType("ROUTE_HANDLED_BY")) {
      const list = handled.get(rel.to) ?? [];
      list.push(rel.from);
      handled.set(rel.to, list);
    }
    for (const [fnId, cvs] of this.consumed) {
      for (const routeId of handled.get(fnId) ?? []) {
        for (const [cvId, localName] of cvs) this.relationship({ from: routeId, to: cvId, type: "CONSUMES_CONFIG", properties: { localName } });
      }
    }
  }

  private readEnvFileNames(): Set<string> {
    const names = new Set<string>();
    for (const file of this.files) {
      if (!isEnvFile(file)) continue;
      const text = this.envTexts.get(file);
      if (text) for (const entry of parseEnvFile(text)) names.add(entry.name);
    }
    return names;
  }

  private envTexts = new Map<string, string>();

  async loadEnvFiles(): Promise<void> {
    for (const file of this.files) {
      if (!isEnvFile(file)) continue;
      const text = await readFile(file, "utf8").catch(() => null);
      if (text !== null) this.envTexts.set(file, text);
    }
  }
}

// `NAME` of every `${NAME}` / `${NAME:default}` in a value.
function placeholderTexts(value: string): string[] {
  return placeholdersOf(value).map((entry) => entry.key);
}

// The field an accessor call is for: `getHost` / `isEnabled` / `setHost` / `host` of the fields `host`, `enabled`.
function accessorField(callee: string, fields: readonly string[]): string | null {
  if (fields.includes(callee)) return callee;
  const match = /^(?:get|is|set)(\p{Lu}.*)$/u.exec(callee);
  if (!match) return null;
  const name = `${match[1]!.charAt(0).toLowerCase()}${match[1]!.slice(1)}`;
  return fields.find((field) => field === name) ?? null;
}


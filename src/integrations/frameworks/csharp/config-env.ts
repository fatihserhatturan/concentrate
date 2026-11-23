import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { GraphSchemaExtension } from "../../../core/graph/schema.js";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";
import { argumentNodes, argumentValue, normalizeCSharpType, trailingGenericArguments } from "../../languages/csharp/syntax.js";
import { declaratorValue } from "../../languages/csharp/calls.js";
import { joinKey, keyToEnvName, readAppSettings, shownConfigValue, shownValue, type AppSettingEntry, type AppSettings } from "./config-files.js";
import { dottedText, invocationInfo, lambdaInfo, type ArgumentInfo, type InvocationInfo } from "./invocations.js";
import { createCSharpReceiverResolver, receiverMatches, type CSharpReceiverResolver } from "./receivers.js";
import { csharpMethods, parametersOf, primaryParametersOf } from "./shared.js";
import { createCSharpStringResolver, literalText, readCSharpString, stringScopeOf, type CSharpStringTemplate } from "./strings.js";

// C# configuration and environment (Phase 47, track C), as Java's `java/config-env.ts` does for Spring.
//
// Config files: every leaf of every `appsettings.json` / `appsettings.<Environment>.json` (`readAppSettings`, read once
// and shared with the HTTP track) is a ConfigValue `{ name: key (colon path), value, valueType, line }` declared by that
// file (DECLARES_CONFIG, id `<file id>:config:<line>:<key>`). A key of `appsettings.Production.json` is its own node in
// that file, never merged with the base one, so the file says the environment. The value of a secret-named key and the
// password of a connection string or URL are `<redacted>` (`shownValue`). Only files named so are read: a
// `ConfigurationBuilder().AddJsonFile("custom.json")`, user secrets, Key Vault and `appsettings` copies outside that
// naming make nothing, and an `IConfiguration` of a custom type is no configuration.
//
// Env reads, as USES_ENV from the reading function (the file for a field initializer) and from the file, to an EnvVar
// (`env:NAME`, as every language makes it; `access` names the call):
//   - `Environment.GetEnvironmentVariable("NAME")` (also `System.Environment.`, a `using static System.Environment`, and the
//     `EnvironmentVariableTarget` overload), `Environment.GetEnvironmentVariables()["NAME"]` (also through a local holding
//     the dictionary) and `Environment.ExpandEnvironmentVariables("a/%NAME%")`. A scanned type named `Environment` is not
//     System's. The name may be a constant (`EnvNames.Queue`, `Prefix + "X"`); a name that is not literal is unresolved.
//
// Config reads, as CONSUMES_CONFIG (to every file's ConfigValue of the key; keys compare case-insensitively with `:` and
// `__` equal) from the reading function, its file and the routes the function handles (`localName` is the key):
//   - the root: `configuration["A:B"]`, `GetValue<T>("A:B"[, default])` / `GetValue(typeof(T), "A:B")`,
//     `GetConnectionString("X")` (= `ConnectionStrings:X`), also `configuration?["A"]`, on a receiver typed
//     `IConfiguration` / `IConfigurationRoot` / `ConfigurationManager` (field, property, parameter, typed lambda parameter,
//     local, primary-constructor parameter) or written `x.Configuration` (`builder.Configuration`, `app.Configuration`,
//     `context.Configuration`: the untyped host builder objects, so only when `x` and the member have no type the scan
//     knows: a scanned type without a `Configuration` member is not the host builder);
//   - sections: `GetSection("A").GetSection("B")["C"]`, `GetSection("A:B")["C"]`, `GetRequiredSection`, a section held in
//     a single-assignment local (`var s = config.GetSection("A");` then `s["B"]`, `s.GetSection("C").Get<T>()`); the
//     section's `.Value` reads that key; `.Get<T>()`, `.Bind(x)`, `.Bind("A", x)` and `.GetChildren()` read every key
//     BELOW the section. A section received as a parameter or field has no known path and reads nothing;
//   - options: `services.Configure<T>(config.GetSection("S"))`, `AddOptions<T>().Bind(config.GetSection("S"))` and
//     `.BindConfiguration("S")` bind the options class `T` to the keys below `S`. The registering function reads them, and
//     so does every function with a parameter (constructor, primary constructor, method, `[FromServices]`) of
//     `IOptions<T>` / `IOptionsSnapshot<T>` / `IOptionsMonitor<T>` (a class with such a field and no such parameter, the
//     class's file only). When `T` is a scanned class the keys narrow to the first segments that match a property it (or a
//     scanned base) declares as public properties or fields (`[ConfigurationKeyName("x")]` renames one), case-insensitively;
//     else all keys below. `localName` is the parameter / field name.
//
// Routes: a read of a function is copied (CONSUMES_CONFIG, USES_ENV) to the Routes that function handles, by where it sits
// (`Slot`): inside a minimal-API lambda, to that lambda's route only (the lambda's own range, lines and columns, as the
// Route's `handlerStart*` / `handlerEnd*`), inside a local function, to the routes whose handler range is that function's,
// else to the routes of a
// controller action or a method-group handler (their env reads: `js-ts.env-config`); the startup code of `<top-level>`
// belongs to no route.
//
// A key read that no appsettings file defines still gets a ConfigValue declared by the reading file: valueType `default`
// with the literal default of `GetValue<T>("k", default)` (redacted for a secret key) or `unset` with an empty value
// (the key may come from the environment, user secrets or a vault). A read of a key that has an appsettings entry is also
// USES_ENV (`access: "config override"`, `line` of the read) of `env:<key with __>` written as the code spells the key
// (`Services__Orders__BaseUrl`), the variable that overrides it; a section read whole (`Get<T>()`, `GetChildren()`,
// options) lists no override.
//
// Keys that are not constant (a parameter, a call, a non-const field) are unresolved, never guessed.
//
// Not handled: `Get<T>()` on the whole configuration, `GetRequiredValue`-style helpers, sections held in fields or passed
// as arguments, `IConfigurationSection` / `IConfigurationRoot` roots of another origin (`new ConfigurationBuilder()...`),
// `IOptions<T>` resolved by `GetRequiredService<IOptions<T>>()`, minimal-API handler parameters of `IOptions<T>`,
// `AddEnvironmentVariables(prefix)` mapping (`APP_` + `A__B`), `ConfigurationManager.AppSettings` (web.config), named
// options, `IConfigureOptions<T>` / `PostConfigure`, and any dynamic key.

// ---------------------------------------------------------------- facts (parse time)

type Template = CSharpStringTemplate;

/** A config expression: the root receiver text and the key segments below it. */
type ChainFact = {
  root: string;
  /** Declared type of a lambda parameter the root names (`(IConfiguration config) => ...`). */
  rt?: string;
  segs: Template[];
};

type Range = [number, number, number, number];

type Place = {
  /** Line of the expression. */
  l: number;
  /** Id of the Function that holds it, null at file level. */
  f: string | null;
  /** Id of the innermost type around it, for resolving constants outside a Function. */
  t: string | null;
  /** Column (0-based) of the expression: picks the typed lambda parameter of the lambda holding it. */
  c?: number;
  /** Range [startLine, startColumn, endLine, endColumn] of the minimal-API lambda handler (of a `Map*` call) that holds it: that route (not the whole Function) reads it. */
  hr?: Range;
  /** Ranges of the local functions around it (a minimal-API handler written as a local function; a route names one by its range). */
  hf?: Range[];
};

type EnvFact = Place & {
  kind: "env";
  api: "get" | "expand" | "map";
  /** Receiver text (`Environment`, `System.Environment`); null for a bare call. */
  recv: string | null;
  name: Template;
};

type ReadFact = Place &
  ChainFact & {
    kind: "read";
    /** Reads the key and everything below it (`Get<T>()`) instead of the key alone. */
    whole: boolean;
    /** The default of `GetValue<T>("k", default)`: its text (empty when not a literal), absent without a default. */
    def?: string;
  };

type BindFact = Place & {
  kind: "bind";
  /** The options class as written. */
  type: string;
  /** Root of the section (null for `BindConfiguration("S")`, which binds from the host configuration). */
  root: string | null;
  rt?: string;
  segs: Template[];
};

type Fact = EnvFact | ReadFact | BindFact;

/** Where a read sits: in a minimal-API lambda (its own range), in local functions (their ranges), or in the Function's body. */
type Slot = { hr?: Range; hf?: Range[] };

const FACTS = "csharpConfigEnv";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/u;
const SECTION_CALLS = new Set(["GetSection", "GetRequiredSection"]);
const OPTIONS_ADDERS = new Set(["AddOptions", "AddOptionsWithValidateOnStart"]);
const CONFIG_TYPES = ["IConfiguration", "IConfigurationRoot", "ConfigurationManager", "ConfigurationRoot"];
const OPTIONS_TYPES = new Set(["IOptions", "IOptionsSnapshot", "IOptionsMonitor"]);
const LITERAL_DEFAULTS = new Set(["integer_literal", "real_literal", "boolean_literal", "null_literal", "character_literal"]);

const isComment = (node: SyntaxNode): boolean => node.type === "comment";

const strip = (node: SyntaxNode): SyntaxNode => {
  let current = node;
  for (;;) {
    if (current.type === "parenthesized_expression") {
      const inner = current.namedChildren.find((child) => !isComment(child));
      if (!inner) return current;
      current = inner;
    } else if (current.type === "postfix_unary_expression" && current.text.endsWith("!")) {
      const inner = current.namedChildren[0];
      if (!inner) return current;
      current = inner;
    } else return current;
  }
};

const contains = (outer: SyntaxNode, inner: SyntaxNode): boolean => outer.startIndex <= inner.startIndex && inner.endIndex <= outer.endIndex;

type Owner = {
  fn: { syntax: SyntaxNode; node: GraphNode };
  scope?: ReturnType<typeof stringScopeOf>;
  parameters: Set<string>;
  declared: Map<string, SyntaxNode[]>;
  assigned: Set<string>;
  aliases: Map<string, Alias | null>;
};
type Alias = { kind: "chain"; chain: ChainFact } | { kind: "envmap"; recv: string | null };

const readConfigEnv: VersionedCSharpParsePlugin = ({ fileNodeId, root, nodes, functions, types }) => {
  const text = root.text;
  if (!/\b(?:GetEnvironmentVariable|GetEnvironmentVariables|ExpandEnvironmentVariables|GetSection|GetRequiredSection|GetValue|GetConnectionString|Configure|AddOptions|AddOptionsWithValidateOnStart|BindConfiguration|IConfiguration|IConfigurationRoot|ConfigurationManager|Configuration)\b/u.test(text)) return;
  const file = nodes.find((node) => node.id === fileNodeId);
  if (!file) return;
  const staticUsing = /\busing\s+static\s+System\.Environment\s*;/u.test(text);

  // Innermost Function / type around a node (the compilation unit of top-level statements is the outermost Function).
  const owners: Owner[] = [...functions]
    .sort((a, b) => a.syntax.endIndex - a.syntax.startIndex - (b.syntax.endIndex - b.syntax.startIndex))
    .map((fn) => ({ fn, parameters: new Set(parametersOf(fn.node).map((parameter) => parameter.name)), declared: new Map(), assigned: new Set(), aliases: new Map() }));
  const typeSyntaxes = [...types].sort((a, b) => a.syntax.endIndex - a.syntax.startIndex - (b.syntax.endIndex - b.syntax.startIndex));
  const ownerOf = (node: SyntaxNode): Owner | undefined => owners.find((owner) => contains(owner.fn.syntax, node));
  const typeOf = (node: SyntaxNode): string | null => typeSyntaxes.find((type) => contains(type.syntax, node))?.node.id ?? null;
  const rangeOf = (node: SyntaxNode): Range => [node.startPosition.row + 1, node.startPosition.column, node.endPosition.row + 1, node.endPosition.column];
  const handlerOf = (node: SyntaxNode, owner: Owner | undefined): Pick<Place, "hr" | "hf"> => {
    let lambda: SyntaxNode | null = null;
    const locals: Range[] = [];
    for (let parent = node.parent; parent && (!owner || parent.id !== owner.fn.syntax.id); parent = parent.parent) {
      if (lambdaInfo(parent)) lambda = parent;
      else if (parent.type === "local_function_statement") locals.push(rangeOf(parent));
      else if (lambda && parent.type === "invocation_expression") {
        const info = invocationInfo(parent);
        if (info && /^Map[A-Z]?\w*$/u.test(info.name)) return { hr: rangeOf(lambda) };
        lambda = null;
      }
    }
    return locals.length === 0 ? {} : { hf: locals };
  };
  const placeOf = (node: SyntaxNode, owner: Owner | undefined): Place => ({ l: node.startPosition.row + 1, c: node.startPosition.column, f: owner?.fn.node.id ?? null, t: typeOf(node), ...handlerOf(node, owner) });

  const scopeOf = (owner: Owner | undefined) => {
    if (!owner) return {};
    return (owner.scope ??= stringScopeOf(owner.fn));
  };
  const template = (node: SyntaxNode, owner: Owner | undefined): Template | null => {
    const read = readCSharpString(node, scopeOf(owner));
    return read && read.length > 0 ? read : null;
  };

  // The declared type of a lambda parameter named by an identifier root (`(IConfiguration config) => config["A"]`).
  const lambdaParameterType = (node: SyntaxNode, name: string, owner: Owner | undefined): string | undefined => {
    for (let parent = node.parent; parent && (!owner || parent.id !== owner.fn.syntax.id); parent = parent.parent) {
      const info = lambdaInfo(parent);
      const found = info?.parameters.find((parameter) => parameter.name === name && parameter.type !== "");
      if (found) return found.type;
    }
    return undefined;
  };

  const rootOf = (node: SyntaxNode, owner: Owner | undefined): ChainFact | null => {
    const inner = strip(node);
    const written = dottedText(inner);
    if (written === null) return null;
    const rt = inner.type === "identifier" ? lambdaParameterType(inner, written, owner) : undefined;
    return { root: written, ...(rt ? { rt } : {}), segs: [] };
  };

  const aliasOf = (owner: Owner | undefined, name: string, depth: number): Alias | null => {
    if (!owner || depth > 4) return null;
    const known = owner.aliases.get(name);
    if (known !== undefined) return known;
    owner.aliases.set(name, null);
    const declarations = owner.declared.get(name) ?? [];
    let alias: Alias | null = null;
    const initializer = declarations.length === 1 && !owner.assigned.has(name) && !owner.parameters.has(name) ? declarations[0] : undefined;
    if (initializer) {
      const inner = strip(initializer);
      const info = invocationInfo(inner);
      if (info?.name === "GetEnvironmentVariables" && info.arguments.length === 0) alias = { kind: "envmap", recv: info.receiver ? dottedText(strip(info.receiver)) : null };
      else {
        const chain = chainBase(inner, owner, depth + 1);
        if (chain) alias = { kind: "chain", chain };
      }
    }
    owner.aliases.set(name, alias);
    return alias;
  };

  // `a.GetSection("A").GetSection("B")`, an alias of one, or a plain receiver (`config`, `this.config`, `builder.Configuration`).
  const chainBase = (node: SyntaxNode, owner: Owner | undefined, depth = 0): ChainFact | null => {
    const inner = strip(node);
    if (inner.type === "invocation_expression") {
      const info = invocationInfo(inner);
      if (!info || !SECTION_CALLS.has(info.name) || info.arguments.length < 1 || !info.receiver) return null;
      const key = template(info.arguments[0]!.node, owner);
      const base = key ? (chainBase(info.receiver, owner, depth) ?? rootOf(info.receiver, owner)) : null;
      return base && key ? { ...base, segs: [...base.segs, key] } : null;
    }
    if (inner.type === "identifier") {
      const alias = aliasOf(owner, inner.text, depth);
      if (alias?.kind === "chain") return { ...alias.chain, segs: [...alias.chain.segs] };
      if (alias?.kind === "envmap") return null;
    }
    return rootOf(inner, owner);
  };

  const optionsTypeOf = (receiver: SyntaxNode | null): string | null => {
    let current = receiver ? strip(receiver) : null;
    while (current && current.type === "invocation_expression") {
      const info = invocationInfo(current);
      if (!info) return null;
      if (OPTIONS_ADDERS.has(info.name) && info.typeArguments.length === 1) return info.typeArguments[0]!;
      current = info.receiver ? strip(info.receiver) : null;
    }
    return null;
  };

  const facts: Fact[] = [];
  const defaultOf = (argument: ArgumentInfo | undefined, owner: Owner | undefined): string | undefined => {
    if (!argument) return undefined;
    if (argument.kind === "string") return argument.value ?? "";
    if (LITERAL_DEFAULTS.has(argument.node.type)) return argument.node.text;
    const read = template(argument.node, owner);
    return literalText(read) ?? "";
  };

  const envFact = (node: SyntaxNode, owner: Owner | undefined, info: InvocationInfo, api: "get" | "expand"): void => {
    const first = info.arguments[0];
    if (!first) return;
    let recv: string | null = null;
    if (info.receiver) {
      recv = dottedText(strip(info.receiver));
      if (recv === null) return;
    } else if (!staticUsing) return;
    const name = template(first.node, owner);
    if (name) facts.push({ kind: "env", api, recv, name, ...placeOf(node, owner) });
  };

  const readFact = (node: SyntaxNode, owner: Owner | undefined, chain: ChainFact, whole: boolean, def?: string): void => {
    if (chain.segs.length === 0) return;
    facts.push({ kind: "read", ...chain, whole, ...(def === undefined ? {} : { def }), ...placeOf(node, owner) });
  };

  const handleInvocation = (node: SyntaxNode, owner: Owner | undefined): void => {
    const info = invocationInfo(node);
    if (!info) return;
    const args = info.arguments;
    switch (info.name) {
      case "GetEnvironmentVariable":
        envFact(node, owner, info, "get");
        return;
      case "ExpandEnvironmentVariables":
        envFact(node, owner, info, "expand");
        return;
      case "GetValue": {
        if (!info.receiver) return;
        const typed = args[0]?.kind === "typeof";
        const generic = info.typeArguments.length === 1;
        if (!typed && !generic) return;
        const keyArg = typed ? args[1] : args[0];
        if (!keyArg) return;
        const key = template(keyArg.node, owner);
        const base = chainBase(info.receiver, owner);
        if (key && base) readFact(node, owner, { ...base, segs: [...base.segs, key] }, false, defaultOf(typed ? args[2] : args[1], owner));
        return;
      }
      case "GetConnectionString": {
        const key = args[0] ? template(args[0].node, owner) : null;
        const base = info.receiver ? chainBase(info.receiver, owner) : null;
        if (key && base && base.segs.length === 0) readFact(node, owner, { ...base, segs: [[{ text: "ConnectionStrings" }], key] }, false);
        return;
      }
      case "Get": {
        // `section.Get<T>()` / `section.Get(typeof(T))`.
        if (!info.receiver || (info.typeArguments.length !== 1 && args[0]?.kind !== "typeof")) return;
        const base = chainBase(info.receiver, owner);
        if (base) readFact(node, owner, base, true);
        return;
      }
      case "GetChildren": {
        const base = info.receiver && args.length === 0 ? chainBase(info.receiver, owner) : null;
        if (base) readFact(node, owner, base, true);
        return;
      }
      case "Bind": {
        if (!info.receiver) return;
        const optionType = optionsTypeOf(info.receiver);
        if (optionType) {
          // `AddOptions<T>().Bind(config.GetSection("S"))`.
          for (const arg of args.slice(0, 1)) {
            const chain = chainBase(arg.node, owner);
            if (chain && chain.segs.length > 0) facts.push({ kind: "bind", type: optionType, root: chain.root, ...(chain.rt ? { rt: chain.rt } : {}), segs: chain.segs, ...placeOf(node, owner) });
          }
          return;
        }
        const base = chainBase(info.receiver, owner);
        if (!base) return;
        // `config.Bind("A", x)` binds the section named by the first argument.
        if (args.length >= 2 && args[0]?.kind === "string") {
          const key = template(args[0].node, owner);
          if (key) readFact(node, owner, { ...base, segs: [...base.segs, key] }, true);
        } else readFact(node, owner, base, true);
        return;
      }
      case "BindConfiguration": {
        const optionType = optionsTypeOf(info.receiver);
        const key = args[0] ? template(args[0].node, owner) : null;
        if (optionType && key) facts.push({ kind: "bind", type: optionType, root: null, segs: [key], ...placeOf(node, owner) });
        return;
      }
      case "Configure": {
        if (info.typeArguments.length !== 1 || !info.receiver) return;
        for (const arg of args) {
          if (arg.kind === "lambda") continue;
          const chain = chainBase(arg.node, owner);
          if (chain && chain.segs.length > 0) {
            facts.push({ kind: "bind", type: info.typeArguments[0]!, root: chain.root, ...(chain.rt ? { rt: chain.rt } : {}), segs: chain.segs, ...placeOf(node, owner) });
            return;
          }
        }
        return;
      }
      default:
    }
  };

  const handleElement = (node: SyntaxNode, expression: SyntaxNode, argument: SyntaxNode | undefined, owner: Owner | undefined): void => {
    if (!argument) return;
    const inner = strip(expression);
    const value = argumentValue(argument);
    if (!value) return;
    const key = template(value, owner);
    if (!key) return;
    // `Environment.GetEnvironmentVariables()["NAME"]` or a local holding the dictionary.
    let envRecv: string | null | undefined;
    const call = invocationInfo(inner);
    if (call?.name === "GetEnvironmentVariables" && call.arguments.length === 0) envRecv = call.receiver ? dottedText(strip(call.receiver)) : staticUsing ? null : undefined;
    else if (inner.type === "identifier") {
      const alias = aliasOf(owner, inner.text, 0);
      if (alias?.kind === "envmap") envRecv = alias.recv;
    }
    if (envRecv !== undefined) {
      if (envRecv !== null || staticUsing) facts.push({ kind: "env", api: "map", recv: envRecv, name: key, ...placeOf(node, owner) });
      return;
    }
    const base = chainBase(inner, owner);
    if (base) readFact(node, owner, { ...base, segs: [...base.segs, key] }, false);
  };

  // One pass: declarations and assignments (for section locals), and the nodes worth reading.
  const interesting: SyntaxNode[] = [];
  const stack: SyntaxNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    switch (node.type) {
      case "variable_declarator": {
        if (node.parent?.parent?.type === "field_declaration") break;
        const name = node.childForFieldName("name")?.text;
        const value = declaratorValue(node);
        const owner = ownerOf(node);
        if (name && owner) {
          const list = owner.declared.get(name) ?? [];
          list.push(...(value ? [value] : [node]));
          owner.declared.set(name, list);
        }
        break;
      }
      case "assignment_expression": {
        const target = node.childForFieldName("left") ?? node.namedChildren[0];
        if (target?.type === "identifier") ownerOf(node)?.assigned.add(target.text);
        break;
      }
      case "invocation_expression":
      case "element_access_expression":
      case "conditional_access_expression":
      case "member_access_expression":
        interesting.push(node);
        break;
      default:
    }
    for (let i = node.namedChildren.length - 1; i >= 0; i -= 1) stack.push(node.namedChildren[i]!);
  }

  for (const node of interesting.reverse()) {
    const owner = ownerOf(node);
    if (node.type === "invocation_expression") handleInvocation(node, owner);
    else if (node.type === "element_access_expression") {
      const target = node.parent?.type === "assignment_expression" && node.parent.childForFieldName("left")?.id === node.id;
      const expression = node.childForFieldName("expression") ?? node.namedChildren[0];
      const subscript = node.childForFieldName("subscript") ?? node.namedChildren.find((child) => child.type === "bracketed_argument_list");
      if (!target && expression) handleElement(node, expression, argumentNodes(subscript)[0], owner);
    } else if (node.type === "conditional_access_expression") {
      // `config?["A"]`
      const expression = node.namedChildren[0];
      const binding = node.namedChildren.find((child) => child.type === "element_binding_expression");
      if (expression && binding) handleElement(node, expression, binding.namedChildren.find((child) => child.type === "argument"), owner);
    } else if (node.childForFieldName("name")?.text === "Value" && node.parent?.type !== "invocation_expression") {
      // `config.GetSection("A").Value` / `section.Value`
      const expression = node.childForFieldName("expression");
      const inner = expression ? strip(expression) : null;
      const chain = inner && (inner.type === "invocation_expression" || inner.type === "identifier") ? chainBase(inner, owner) : null;
      const target = node.parent?.type === "assignment_expression" && node.parent.childForFieldName("left")?.id === node.id;
      if (chain && !target) readFact(node, owner, chain, false);
    }
  }
  if (facts.length === 0) return;
  file.properties[FACTS] = JSON.stringify(facts);
};

export const csharpConfigEnvPlugin: VersionedCSharpParsePlugin = Object.assign(readConfigEnv, { version: "2" });

// ---------------------------------------------------------------- contributor

function safeFacts(value: unknown): Fact[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? (parsed as Fact[]) : [];
  } catch {
    return [];
  }
}

const configValueId = (fileId: string, line: number, key: string): string => `${fileId}:config:${line}:${key}`;
const lastSegment = (name: string): string => name.split(".").at(-1) ?? name;

export const csharpConfigEnvContributor: ISemanticContributor = {
  id: "csharp.config-env",
  version: "1",
  async contribute(graph, rootPath, _report, files) {
    // Facts of the parse, read once and removed (they are not graph properties).
    const facts = new Map<string, Fact[]>();
    for (const file of graph.nodesWithLabel("File")) {
      const parsed = safeFacts(file.properties[FACTS]);
      delete file.properties[FACTS];
      if (parsed.length > 0) facts.set(file.id, parsed);
    }
    const settings = await readAppSettings(rootPath, files);
    if (facts.size === 0 && settings.entries.length === 0) return;
    new Builder(graph, settings, facts).run();
  },
};

type OptionsBinding = {
  /** Section key, relative to the host configuration. */
  key: string;
  /** The options class scanned, or null. */
  type: GraphNode | null;
  name: string;
  fnId: string | null;
  fileId: string;
  line: number;
};

class Builder {
  private readonly receivers: CSharpReceiverResolver;
  private readonly strings: ReturnType<typeof createCSharpStringResolver>;
  private readonly fileByPath = new Map<string, string>();
  private readonly relationshipKeys = new Set<string>();
  private readonly cvByEntry = new Map<AppSettingEntry, string>();
  // Function -> reads with the handler they sit in, for the routes the Function handles.
  private readonly consumed = new Map<string, Array<Slot & { cv: string; localName: string }>>();

  constructor(
    private readonly graph: IGraphContributor,
    private readonly settings: AppSettings,
    private readonly facts: ReadonlyMap<string, Fact[]>,
  ) {
    this.receivers = createCSharpReceiverResolver(graph);
    this.strings = createCSharpStringResolver(graph);
    for (const file of graph.nodesWithLabel("File")) {
      if (typeof file.properties.relativePath === "string") this.fileByPath.set(file.properties.relativePath.split("\\").join("/"), file.id);
    }
  }

  run(): void {
    this.declareConfigFiles();
    this.readEnvironment();
    this.readConfiguration();
    this.readOptions();
    this.copyToRoutes();
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

  // Function -> env reads with the handler they sit in, for the routes of a minimal-API handler.
  private readonly envReads = new Map<string, Array<Slot & { to: string; line: number; access: string }>>();

  private useEnv(fnId: string | null, fileId: string, name: string, line: number, access: string, slot: Slot = {}): void {
    const to = this.envVar(name);
    if (fnId) {
      const list = this.envReads.get(fnId) ?? [];
      list.push({ ...slot, to, line, access });
      this.envReads.set(fnId, list);
    }
    for (const from of fnId ? [fnId, fileId] : [fileId]) this.relationship({ from, to, type: "USES_ENV", properties: { line, access } });
  }

  private consume(fnId: string | null, fileId: string, cvId: string, localName: string, slot: Slot = {}): void {
    for (const from of fnId ? [fnId, fileId] : [fileId]) this.relationship({ from, to: cvId, type: "CONSUMES_CONFIG", properties: { localName } });
    if (fnId) {
      const list = this.consumed.get(fnId) ?? [];
      list.push({ ...slot, cv: cvId, localName });
      this.consumed.set(fnId, list);
    }
  }

  // The handler a read sits in, with the route pattern resolved (a read of a Function body has none).
  private slotOf(fact: Place): Slot {
    if (fact.hr) return { hr: fact.hr };
    return fact.hf ? { hf: fact.hf } : {};
  }

  // ---- config files

  private declareConfigFiles(): void {
    const known = new Set<string>();
    for (const entry of this.settings.entries) {
      const fileId = this.fileByPath.get(entry.file);
      if (!fileId) continue;
      const id = configValueId(fileId, entry.line, entry.key);
      this.cvByEntry.set(entry, id);
      if (known.has(id)) continue;
      known.add(id);
      this.graph.addNode({ id, label: "ConfigValue", properties: { name: entry.key, value: shownValue(entry), valueType: entry.valueType, line: entry.line } });
      this.relationship({ from: fileId, to: id, type: "DECLARES_CONFIG", properties: {} });
    }
  }

  // ---- scopes and types

  private at(fact: Place): { line: number; column: number } | undefined {
    return fact.c === undefined ? undefined : { line: fact.l, column: fact.c };
  }

  private scopeNode(fact: Place, fileId: string): GraphNode {
    return (fact.f ? this.graph.node(fact.f) : undefined) ?? (fact.t ? this.graph.node(fact.t) : undefined) ?? this.graph.node(fileId)!;
  }

  private literal(template: Template, scope: GraphNode): string | null {
    return literalText(this.strings.resolvePartsAt(template, scope));
  }

  private typeMatches(typeText: string, scope: GraphNode, names: readonly string[]): boolean {
    const typeName = normalizeCSharpType(typeText);
    if (!typeName) return false;
    const type = this.receivers.types.resolve(typeText, scope) ?? this.receivers.types.resolve(typeName, scope);
    return receiverMatches({ typeName, typeArguments: trailingGenericArguments(typeText) ?? [], fullType: null, type, via: "local" }, names, this.receivers);
  }

  // A receiver that is the host configuration (`IConfiguration` typed, or `x.Configuration` of an untyped host builder).
  private isConfiguration(root: string, rt: string | undefined, scope: GraphNode, at?: { line: number; column: number }): boolean {
    if (rt) return this.typeMatches(rt, scope, CONFIG_TYPES);
    const type = this.receivers.typeOf(root, scope, at);
    if (type && type.via !== "static") return receiverMatches(type, CONFIG_TYPES, this.receivers);
    // `x.Configuration` of an untyped receiver only: a scanned type without a `Configuration` member is not the host builder.
    if (lastSegment(root) !== "Configuration" || type !== null) return false;
    const dot = root.lastIndexOf(".");
    const owner = dot === -1 ? null : this.receivers.typeOf(root.slice(0, dot), scope, at);
    return owner === null || owner.type === null;
  }

  // ---- env reads

  private readEnvironment(): void {
    for (const [fileId, list] of this.facts) {
      for (const fact of list) {
        if (fact.kind !== "env") continue;
        const scope = this.scopeNode(fact, fileId);
        // A scanned type named `Environment` is not System's.
        if (fact.recv !== null && !receiverMatches(this.receivers.typeOf(fact.recv, scope, this.at(fact)), ["Environment"], this.receivers)) continue;
        const name = this.literal(fact.name, scope);
        if (name === null) continue;
        const access = fact.api === "get" ? "Environment.GetEnvironmentVariable" : fact.api === "map" ? "Environment.GetEnvironmentVariables" : "Environment.ExpandEnvironmentVariables";
        const names = fact.api === "expand" ? [...name.matchAll(/%([^%\s]+)%/gu)].map((match) => match[1]!) : [name];
        for (const variable of names) if (ENV_NAME.test(variable)) this.useEnv(fact.f, fileId, variable, fact.l, access, this.slotOf(fact));
      }
    }
  }

  // ---- IConfiguration reads

  private keyOf(segs: readonly Template[], scope: GraphNode): string | null {
    const parts: string[] = [];
    for (const seg of segs) {
      const text = this.literal(seg, scope);
      if (text === null || text.trim() === "") return null;
      parts.push(text.trim());
    }
    return joinKey(...parts);
  }

  private readConfiguration(): void {
    for (const [fileId, list] of this.facts) {
      for (const fact of list) {
        if (fact.kind !== "read") continue;
        const scope = this.scopeNode(fact, fileId);
        if (!this.isConfiguration(fact.root, fact.rt, scope, this.at(fact))) continue;
        const key = this.keyOf(fact.segs, scope);
        if (key === null) continue;
        const entries = this.settings.entriesFor(key, { below: fact.whole });
        for (const entry of entries) {
          const id = this.cvByEntry.get(entry);
          if (id) this.consume(fact.f, fileId, id, key, this.slotOf(fact));
        }
        if (fact.whole) continue;
        if (entries.length > 0) {
          this.useEnv(fact.f, fileId, keyToEnvName(key), fact.l, "config override", this.slotOf(fact));
          continue;
        }
        // No file defines the key: the read itself is the record (its default, or `unset`).
        const id = configValueId(fileId, fact.l, key);
        if (!this.graph.node(id)) {
          this.graph.addNode({ id, label: "ConfigValue", properties: { name: key, value: fact.def === undefined ? "" : shownConfigValue(key, fact.def), valueType: fact.def === undefined ? "unset" : "default", line: fact.l } });
          this.relationship({ from: fileId, to: id, type: "DECLARES_CONFIG", properties: {} });
        }
        this.consume(fact.f, fileId, id, key, this.slotOf(fact));
      }
    }
  }

  // ---- options

  // Lower-cased configuration key names of the public properties and fields `type` and its scanned bases declare
  // (`[ConfigurationKeyName("x")]` renames a property's key).
  private memberNames(type: GraphNode): Set<string> {
    const names = new Set<string>();
    const scanned = this.receivers.types.typeOf(type);
    const visit = (current: NonNullable<typeof scanned>, seen: Set<string>): void => {
      if (seen.has(current.id)) return;
      seen.add(current.id);
      for (const rel of ["DEFINES_FIELD", "DEFINES_INTERFACE_FIELD"] as const) {
        for (const edge of this.fieldEdges(rel, current.id)) {
          const field = this.graph.node(edge.to);
          if (!field || field.properties.isStatic === true || field.properties.fieldKind === "constant") continue;
          if (rel === "DEFINES_FIELD" && field.properties.visibility !== "public") continue;
          names.add((this.configurationKeyName(field.id) ?? String(field.properties.name)).toLowerCase());
        }
      }
      for (const parent of this.receivers.types.index.supertypes(current)) visit(parent, seen);
    };
    if (scanned) visit(scanned, new Set());
    return names;
  }

  private decoratorsByField: Map<string, GraphNode[]> | undefined;
  // The key a `[ConfigurationKeyName("x")]` attribute of a member gives it.
  private configurationKeyName(fieldId: string): string | null {
    if (!this.decoratorsByField) {
      this.decoratorsByField = new Map();
      for (const rel of this.graph.relationshipsOfType("FIELD_HAS_DECORATOR" as GraphRelationship["type"])) {
        const decorator = this.graph.node(rel.to);
        if (!decorator) continue;
        const list = this.decoratorsByField.get(rel.from);
        if (list) list.push(decorator);
        else this.decoratorsByField.set(rel.from, [decorator]);
      }
    }
    for (const decorator of this.decoratorsByField.get(fieldId) ?? []) {
      const name = String(decorator.properties.name).split(".").at(-1)?.replace(/Attribute$/u, "");
      if (name !== "ConfigurationKeyName") continue;
      try {
        const args: unknown = JSON.parse(String(decorator.properties.args));
        const first = Array.isArray(args) ? String(args[0] ?? "") : "";
        const match = /^@?"(.*)"$/su.exec(first);
        if (match && match[1]) return match[1];
      } catch {
        // no usable argument
      }
    }
    return null;
  }

  private fieldEdgesCache = new Map<string, Map<string, GraphRelationship[]>>();
  private fieldEdges(type: "DEFINES_FIELD" | "DEFINES_INTERFACE_FIELD", ownerId: string): GraphRelationship[] {
    let byOwner = this.fieldEdgesCache.get(type);
    if (!byOwner) {
      byOwner = new Map();
      for (const rel of this.graph.relationshipsOfType(type as GraphRelationship["type"])) {
        const list = byOwner.get(rel.from);
        if (list) list.push(rel);
        else byOwner.set(rel.from, [rel]);
      }
      this.fieldEdgesCache.set(type, byOwner);
    }
    return byOwner.get(ownerId) ?? [];
  }

  // The entries below `key` of the properties `type` declares (all of them when the class is unknown or declares none).
  private boundEntries(key: string, type: GraphNode | null): AppSettingEntry[] {
    const entries = this.settings.entriesFor(key, { below: true });
    const names = type ? this.memberNames(type) : new Set<string>();
    if (names.size === 0) return entries;
    const prefix = key.replace(/__/gu, ":").toLowerCase().length + 1;
    return entries.filter((entry) => {
      const rest = entry.canonical.slice(prefix);
      return entry.canonical.length < prefix || names.has(rest.split(":")[0] ?? "");
    });
  }

  private readOptions(): void {
    const bindings = new Map<string, OptionsBinding[]>();
    const typeKey = (type: GraphNode | null, written: string): string => (type ? type.id : `name:${lastSegment(normalizeCSharpType(written) ?? written)}`);
    for (const [fileId, list] of this.facts) {
      for (const fact of list) {
        if (fact.kind !== "bind") continue;
        const scope = this.scopeNode(fact, fileId);
        if (fact.root !== null && !this.isConfiguration(fact.root, fact.rt, scope, this.at(fact))) continue;
        const key = this.keyOf(fact.segs, scope);
        if (key === null) continue;
        const resolved = this.receivers.types.resolve(fact.type, scope);
        const name = lastSegment(normalizeCSharpType(fact.type) ?? fact.type);
        const id = typeKey(resolved?.node ?? null, fact.type);
        const binding: OptionsBinding = { key, type: resolved?.node ?? null, name, fnId: fact.f, fileId, line: fact.l };
        bindings.set(id, [...(bindings.get(id) ?? []), binding]);
        // The registering function binds (reads) the section.
        for (const entry of this.boundEntries(key, binding.type)) {
          const cv = this.cvByEntry.get(entry);
          if (cv) this.consume(fact.f, fileId, cv, name);
        }
      }
    }
    if (bindings.size === 0) return;

    const consumeBound = (fnId: string | null, fileId: string, bound: readonly OptionsBinding[], localName: string): void => {
      for (const binding of bound) {
        for (const entry of this.boundEntries(binding.key, binding.type)) {
          const cv = this.cvByEntry.get(entry);
          if (cv) this.consume(fnId, fileId, cv, localName);
        }
      }
    };
    const optionsOf = (typeText: string, scope: GraphNode): OptionsBinding[] | undefined => {
      const name = normalizeCSharpType(typeText);
      const args = trailingGenericArguments(typeText);
      if (!name || !args || args.length !== 1 || !OPTIONS_TYPES.has(lastSegment(name))) return undefined;
      // A scanned `IOptions` of the project's own is not Microsoft's.
      if (this.receivers.types.resolve(typeText, scope)) return undefined;
      const resolved = this.receivers.types.resolve(args[0]!, scope);
      return bindings.get(typeKey(resolved?.node ?? null, args[0]!));
    };

    const injected = new Set<string>();
    for (const method of csharpMethods(this.graph)) {
      for (const parameter of parametersOf(method.node)) {
        const bound = optionsOf(parameter.type, method.node);
        if (!bound) continue;
        consumeBound(method.node.id, method.fileId, bound, parameter.name);
        injected.add(`${method.owner.id}\0${parameter.type.replace(/\s+/gu, "")}`);
      }
    }
    // A primary-constructor parameter (the class has no constructor Function carrying it).
    for (const type of this.graph.nodesWithLabel("Class")) {
      for (const parameter of primaryParametersOf(type)) {
        const bound = optionsOf(parameter.type, type);
        if (!bound) continue;
        const ctor = csharpMethods(this.graph).find((method) => method.owner.id === type.id && method.node.properties.kind === "constructor" && parametersOf(method.node).some((candidate) => candidate.name === parameter.name && candidate.type === parameter.type));
        const fileId = this.fileOf(type);
        if (!fileId) continue;
        consumeBound(ctor?.node.id ?? null, fileId, bound, parameter.name);
        injected.add(`${type.id}\0${parameter.type.replace(/\s+/gu, "")}`);
      }
    }
    // A field of the options type no constructor parameter feeds: the class's file reads it.
    for (const field of this.graph.nodesWithLabel("Field")) {
      const declared = field.properties.declaredType;
      if (typeof declared !== "string") continue;
      const bound = optionsOf(declared, field);
      const fileId = bound ? this.fileOfMember(field.id) : undefined;
      if (!bound || !fileId) continue;
      const owner = this.fieldOwner(field.id);
      if (owner && injected.has(`${owner}\0${declared.replace(/\s+/gu, "")}`)) continue;
      consumeBound(null, fileId, bound, String(field.properties.name));
    }
  }

  private fieldOwnerCache: Map<string, string> | undefined;
  private fieldOwner(fieldId: string): string | undefined {
    if (!this.fieldOwnerCache) {
      this.fieldOwnerCache = new Map();
      for (const type of ["DEFINES_FIELD", "DEFINES_INTERFACE_FIELD"] as const) {
        for (const rel of this.graph.relationshipsOfType(type as GraphRelationship["type"])) this.fieldOwnerCache.set(rel.to, rel.from);
      }
    }
    return this.fieldOwnerCache.get(fieldId);
  }

  private fileOfMember(id: string): string | undefined {
    return /^(file:.+?):(?:function|field|class|interface):\d+:/u.exec(id)?.[1];
  }

  private fileOf(type: GraphNode): string | undefined {
    return this.fileOfMember(type.id);
  }

  // ---- routes

  private copyToRoutes(): void {
    // The routes of a reading handler read the same config (the env reads of a method-group handler follow in `js-ts.env-config`).
    const handled = new Map<string, string[]>();
    for (const rel of this.graph.relationshipsOfType("ROUTE_HANDLED_BY")) {
      const list = handled.get(rel.to) ?? [];
      list.push(rel.from);
      handled.set(rel.to, list);
    }
    // The handler range a Route carries (its lambda, or the local function it names), null for a method group.
    const rangeOfRoute = (route: GraphNode): Range | null => {
      const p = route.properties;
      return typeof p.handlerStartLine === "number" && typeof p.handlerStartColumn === "number" && typeof p.handlerEndLine === "number" && typeof p.handlerEndColumn === "number"
        ? [p.handlerStartLine, p.handlerStartColumn, p.handlerEndLine, p.handlerEndColumn]
        : null;
    };
    const same = (a: Range, b: Range): boolean => a.every((value, index) => value === b[index]);
    // Whether a read of `fnId` (placed by `slot`) belongs to the route.
    const belongs = (fnId: string, route: GraphNode, slot: Slot): boolean => {
      const topLevel = this.graph.node(fnId)?.properties.qualifiedName === "<top-level>";
      const range = rangeOfRoute(route);
      // Inside a lambda: the route of that lambda, by its own range.
      if (slot.hr) return range !== null && route.properties.handlerName === "<lambda>" && same(range, slot.hr);
      // Inside local functions: the route naming one of them as its handler.
      if (slot.hf) return range !== null && route.properties.handlerName !== "<lambda>" && slot.hf.some((candidate) => same(candidate, range));
      // The Function's own body: the startup code of `<top-level>` belongs to no route, nor does a lambda or local-function route read it.
      return !topLevel && range === null;
    };
    for (const [fnId, reads] of this.consumed) {
      for (const routeId of handled.get(fnId) ?? []) {
        const route = this.graph.node(routeId);
        if (!route) continue;
        const seen = new Set<string>();
        for (const read of reads) {
          if (seen.has(read.cv) || !belongs(fnId, route, read)) continue;
          seen.add(read.cv);
          this.relationship({ from: routeId, to: read.cv, type: "CONSUMES_CONFIG", properties: { localName: read.localName } });
        }
      }
    }
    // Env reads: a lambda's own reads and a local function's go to its route here; `js-ts.env-config` copies the other handlers'.
    for (const [fnId, reads] of this.envReads) {
      for (const routeId of handled.get(fnId) ?? []) {
        const route = this.graph.node(routeId);
        if (route?.properties.framework !== "aspnet-minimal" || typeof route.properties.handlerName !== "string") continue;
        for (const read of reads) {
          if (!read.hr && !read.hf) continue;
          if (belongs(fnId, route, read)) this.relationship({ from: routeId, to: read.to, type: "USES_ENV", properties: { line: read.line, access: read.access } });
        }
      }
    }
  }
}

// Graph schema additions of this track: none (ConfigValue, EnvVar, DECLARES_CONFIG, CONSUMES_CONFIG and USES_ENV exist).
export const csharpConfigEnvSchema: GraphSchemaExtension = { id: "csharp-config-env" };


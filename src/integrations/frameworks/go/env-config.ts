import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { localTypes, type GoParsePlugin } from "../../languages/go/parser.js";
import { importedPackages } from "./routes.js";

// Go env reads, as USES_ENV from the function that reads (the file for a
// package-level read) to an EnvVar:
//   - `os.Getenv("PORT")`, `os.LookupEnv`, `syscall.Getenv`, and each
//     `$NAME`/`${NAME}` of an `os.ExpandEnv` literal;
//   - viper: `BindEnv("key", "NAME")`, `BindEnv("key")`, and the `Get*`/
//     `IsSet` reads of a viper with `AutomaticEnv()`, named the way viper
//     names them (`SetEnvPrefix`, `SetEnvKeyReplacer(strings.NewReplacer(…))`;
//     a file without settings of its own takes the repo's);
//   - struct tags: `env:"NAME"` (caarlos0/env, cleanenv, go-envconfig;
//     `envPrefix` on a nested struct field), read by the function of the
//     file that parses the struct, else by the struct's file; and the fields
//     of a struct `envconfig.Process("prefix", &spec)` fills (kelseyhightower/
//     envconfig: `PREFIX_FIELD`, `envconfig:"name"`, `split_words`).
// The variables `.env` files declare come from the language-neutral env files
// contributor.

const VIPER_PACKAGE = "github.com/spf13/viper";
const ENVCONFIG_PACKAGE = "github.com/kelseyhightower/envconfig";

type EnvRead = { name: string; line: number; access: string };

// What viper settings a file makes, and the viper reads whose names depend
// on them; kept on the File node until every file is parsed.
type ViperSettings = { automaticEnv: boolean; prefix: string | null; replacer: Array<[string, string]> };
type ViperRead = { source: string; key: string; line: number; access: string; automatic: boolean };
type ViperFile = { settings: ViperSettings; reads: ViperRead[] };

type Struct = { fields: Array<{ name: string | null; type: string; tags: Map<string, string>; line: number }> };

export const goEnvConfigPlugin: GoParsePlugin = ({ fileNodeId, root, nodes, relationships, functions }) => {
  const imports = importedPackages(root);
  const os = imports.get("os");
  const syscall = imports.get("syscall");
  const viper = imports.get(VIPER_PACKAGE);
  const envconfig = imports.get(ENVCONFIG_PACKAGE);

  // The function a line belongs to: the innermost Function of the file
  // (closures a framework made a Function of their own included).
  const owners = nodes
    .filter((node) => node.label === "Function" && node.id.startsWith(`${fileNodeId}:`) && typeof node.properties.line === "number" && typeof node.properties.endLine === "number")
    .map((node) => ({ id: node.id, line: Number(node.properties.line), endLine: Number(node.properties.endLine) }));
  const ownerOf = (line: number) => owners
    .filter((owner) => owner.line <= line && line <= owner.endLine)
    .sort((left, right) => (left.endLine - left.line) - (right.endLine - right.line))[0]?.id ?? fileNodeId;

  const reads = new Map<string, EnvRead[]>();
  const read = (source: string, entry: EnvRead) => {
    if (!/^[A-Za-z_]\w*$/u.test(entry.name)) return;
    reads.set(source, [...reads.get(source) ?? [], entry]);
  };

  // viper instances: the package and the names `viper.New()` is assigned to.
  const vipers = new Set<string>(viper ? [viper] : []);
  if (viper) {
    for (const call of root.descendantsOfType("call_expression")) {
      if (selector(call) !== `${viper}.New`) continue;
      const declaration = call.parent?.parent;
      if (declaration?.type !== "short_var_declaration" && declaration?.type !== "assignment_statement" && declaration?.type !== "var_spec") continue;
      const left = declaration.type === "var_spec" ? declaration.childrenForFieldName("name") : declaration.childForFieldName("left")?.namedChildren ?? [];
      const name = left[0]?.text;
      if (name && name !== "_") vipers.add(name);
    }
  }
  const viperFile: ViperFile = { settings: { automaticEnv: false, prefix: null, replacer: [] }, reads: [] };

  const structs = structTypes(root);
  const parsedStructs: Array<{ type: string; source: string; envconfigPrefix?: string }> = [];

  for (const call of root.descendantsOfType("call_expression")) {
    const callee = selector(call);
    if (!callee) continue;
    const [receiver, method] = splitSelector(callee);
    const args = call.childForFieldName("arguments")?.namedChildren ?? [];
    const line = call.startPosition.row + 1;
    const first = args[0] ? stringLiteral(args[0]) : null;

    if ((receiver === os || receiver === syscall) && receiver && (method === "Getenv" || method === "LookupEnv")) {
      if (first !== null) read(ownerOf(line), { name: first, line, access: `${receiver === os ? "os" : "syscall"}.${method}` });
    } else if (receiver === os && method === "ExpandEnv" && first !== null) {
      for (const match of first.matchAll(/\$(?:\{([A-Za-z_]\w*)\}|([A-Za-z_]\w*))/gu)) {
        read(ownerOf(line), { name: match[1] ?? match[2]!, line, access: "os.ExpandEnv" });
      }
    } else if (vipers.has(receiver)) {
      const access = `viper.${method}`;
      if (method === "AutomaticEnv") viperFile.settings.automaticEnv = true;
      else if (method === "SetEnvPrefix" && first !== null) viperFile.settings.prefix = first;
      else if (method === "SetEnvKeyReplacer") viperFile.settings.replacer = replacerPairs(args[0]);
      else if (method === "BindEnv" && first !== null) {
        const names = args.slice(1).map(stringLiteral);
        if (names.length > 0) {
          for (const name of names) if (name !== null) read(ownerOf(line), { name, line, access });
        } else {
          viperFile.reads.push({ source: ownerOf(line), key: first, line, access, automatic: false });
        }
      } else if ((/^Get[A-Z]?\w*$/u.test(method) && method !== "GetViper") || method === "IsSet") {
        if (first !== null) viperFile.reads.push({ source: ownerOf(line), key: first, line, access, automatic: true });
      }
    } else if (envconfig && receiver === envconfig && (method === "Process" || method === "MustProcess") && args.length >= 2) {
      const type = structOf(args[1]!, call, functions.map((fn) => fn.syntax), root);
      if (type && first !== null) parsedStructs.push({ type, source: ownerOf(line), envconfigPrefix: first });
    } else if (method === "Parse" || method === "ParseWithOptions" || method === "MustParse" || method === "ReadEnv" || method === "ReadConfig" || method === "Process" || method === "MustProcess") {
      // caarlos0/env, cleanenv, go-envconfig: the struct is the first
      // pointer argument (after a context for go-envconfig).
      const target = args.find((arg) => arg.type === "unary_expression" && arg.text.startsWith("&"));
      const type = target ? structOf(target, call, functions.map((fn) => fn.syntax), root) : null;
      if (type) parsedStructs.push({ type, source: ownerOf(line) });
    }
  }

  // Struct tags: the fields of each struct with `env:"…"` tags, read where
  // the struct is parsed, else by the file.
  const nested = new Set<string>();
  for (const struct of structs.values()) {
    for (const field of struct.fields) if (field.tags.has("envPrefix")) nested.add(bareType(field.type));
  }
  const parsedBy = new Map<string, string[]>();
  for (const parsed of parsedStructs) {
    if (parsed.envconfigPrefix !== undefined) {
      for (const entry of envconfigNames(parsed.type, parsed.envconfigPrefix, structs, 0)) read(parsed.source, entry);
    } else {
      parsedBy.set(parsed.type, [...parsedBy.get(parsed.type) ?? [], parsed.source]);
    }
  }
  for (const type of structs.keys()) {
    const sources = parsedBy.get(type) ?? (nested.has(type) ? [] : [fileNodeId]);
    const names = envTagNames(type, "", structs, 0);
    for (const source of new Set(sources)) for (const entry of names) read(source, entry);
  }

  // Each read is the file's too, as for JS.
  const seen = new Set<string>();
  for (const [source, entries] of reads) {
    for (const entry of entries) {
      for (const from of source === fileNodeId ? [source] : [source, fileNodeId]) {
        const key = `${from}\0${entry.name}\0${entry.line}\0${entry.access}`;
        if (seen.has(key)) continue;
        seen.add(key);
        nodes.push(envVarNode(entry.name));
        relationships.push({ from, to: `env:${entry.name}`, type: "USES_ENV", properties: { line: entry.line, access: entry.access } });
      }
    }
  }

  const fileNode = nodes.find((node) => node.id === fileNodeId);
  if (fileNode && (viperFile.reads.length > 0 || viperFile.settings.automaticEnv || viperFile.settings.prefix !== null)) {
    fileNode.properties.goViper = JSON.stringify(viperFile);
  }
};

// Names the viper reads once every file is parsed: a file's own settings, or
// the repo's when the file makes none (`AutomaticEnv` in main, `Get*` in a
// config package).
export const goEnvConfigContributor: ISemanticContributor = {
  contribute(graph) {
    const files = graph.nodes.filter((node) => node.label === "File" && typeof node.properties.goViper === "string");
    if (files.length === 0) return;
    const parsed = files.map((file) => {
      const value = JSON.parse(String(file.properties.goViper)) as ViperFile;
      delete file.properties.goViper;
      return { ...value, fileId: file.id };
    });
    const configured = parsed.filter((file) => file.settings.automaticEnv || file.settings.prefix !== null);
    const prefixes = [...new Set(configured.map((file) => file.settings.prefix).filter((prefix): prefix is string => prefix !== null))];
    const repo: ViperSettings = {
      automaticEnv: configured.some((file) => file.settings.automaticEnv),
      prefix: prefixes.length === 1 ? prefixes[0]! : null,
      replacer: configured.find((file) => file.settings.replacer.length > 0)?.settings.replacer ?? [],
    };
    const nodes: GraphNode[] = [];
    const relationships: GraphRelationship[] = [];
    for (const file of parsed) {
      const settings = file.settings.automaticEnv || file.settings.prefix !== null ? file.settings : repo;
      for (const entry of file.reads) {
        if (entry.automatic && !settings.automaticEnv) continue;
        const name = viperEnvName(entry.key, settings);
        if (!/^[A-Za-z_]\w*$/u.test(name)) continue;
        nodes.push(envVarNode(name));
        for (const from of new Set([entry.source, file.fileId])) {
          relationships.push({ from, to: `env:${name}`, type: "USES_ENV", properties: { line: entry.line, access: entry.access } });
        }
      }
    }
    graph.addNodes(nodes);
    graph.addRelationships(relationships);
  },
};

// viper: `PREFIX_KEY`, upper-cased, with the key replacer applied.
function viperEnvName(key: string, settings: ViperSettings): string {
  let name = (settings.prefix ? `${settings.prefix}_${key}` : key).toUpperCase();
  for (const [from, to] of settings.replacer) name = name.split(from).join(to);
  return name;
}

function envVarNode(name: string): GraphNode {
  return { id: `env:${name}`, label: "EnvVar", properties: { name } };
}

// `env:"PORT,required"` fields, and those of a nested struct under its
// `envPrefix`.
function envTagNames(type: string, prefix: string, structs: Map<string, Struct>, depth: number): EnvRead[] {
  const struct = structs.get(type);
  if (!struct || depth > 4) return [];
  const names: EnvRead[] = [];
  for (const field of struct.fields) {
    const env = field.tags.get("env")?.split(",")[0]?.trim();
    if (env && env !== "-") names.push({ name: `${prefix}${env}`, line: field.line, access: "env struct tag" });
    const nestedPrefix = field.tags.get("envPrefix");
    if (nestedPrefix !== undefined) names.push(...envTagNames(bareType(field.type), `${prefix}${nestedPrefix}`, structs, depth + 1));
  }
  return names;
}

// kelseyhightower/envconfig: every exported field, `PREFIX_NAME` upper-cased;
// a nested struct's fields under `PREFIX_FIELD_`, an embedded one's under the
// same prefix.
function envconfigNames(type: string, prefix: string, structs: Map<string, Struct>, depth: number): EnvRead[] {
  const struct = structs.get(type);
  if (!struct || depth > 4) return [];
  const names: EnvRead[] = [];
  for (const field of struct.fields) {
    if (field.tags.get("ignored") === "true") continue;
    const fieldName = field.name ?? bareType(field.type).split(".").pop()!;
    if (!/^[A-Z]/u.test(fieldName)) continue;
    const tag = field.tags.get("envconfig")?.split(",")[0];
    const name = tag || (field.tags.get("split_words") === "true" ? fieldName.replace(/([a-z0-9])([A-Z])/gu, "$1_$2") : fieldName);
    const key = (prefix ? `${prefix}_${name}` : name).toUpperCase();
    const inner = structs.get(bareType(field.type));
    if (inner) {
      names.push(...envconfigNames(bareType(field.type), field.name === null ? prefix : key, structs, depth + 1));
      continue;
    }
    names.push({ name: key, line: field.line, access: "envconfig" });
  }
  return names;
}

function structTypes(root: SyntaxNode): Map<string, Struct> {
  const structs = new Map<string, Struct>();
  for (const spec of root.descendantsOfType("type_spec")) {
    const name = spec.childForFieldName("name")?.text;
    const type = spec.childForFieldName("type");
    if (!name || type?.type !== "struct_type") continue;
    const fields: Struct["fields"] = [];
    const list = type.namedChildren.find((child) => child.type === "field_declaration_list");
    for (const declaration of list?.namedChildren ?? []) {
      if (declaration.type !== "field_declaration") continue;
      const fieldType = declaration.childForFieldName("type")?.text ?? "";
      const tagText = declaration.childForFieldName("tag")?.text.slice(1, -1) ?? "";
      const tags = new Map([...tagText.matchAll(/(\w+):"([^"]*)"/gu)].map((match) => [match[1]!, match[2]!]));
      const line = declaration.startPosition.row + 1;
      const names = declaration.childrenForFieldName("name");
      if (names.length === 0) fields.push({ name: null, type: fieldType, tags, line });
      for (const fieldName of names) fields.push({ name: fieldName.text, type: fieldType, tags, line });
    }
    structs.set(name, { fields });
  }
  return structs;
}

// The same-file struct type `&cfg`, `&Config{}` or `cfg` stands for.
function structOf(argument: SyntaxNode, call: SyntaxNode, functionSyntaxes: SyntaxNode[], root: SyntaxNode): string | null {
  let expression = argument;
  if (expression.type === "unary_expression") expression = expression.childForFieldName("operand") ?? expression;
  if (expression.type === "composite_literal") return bareType(expression.childForFieldName("type")?.text ?? "");
  if (expression.type !== "identifier") return null;
  const enclosing = functionSyntaxes
    .filter((syntax) => syntax.startIndex <= call.startIndex && call.endIndex <= syntax.endIndex)
    .sort((left, right) => (left.endIndex - left.startIndex) - (right.endIndex - right.startIndex))[0];
  const local = enclosing ? localTypes(enclosing).get(expression.text) : undefined;
  if (local && "type" in local) return bareType(local.type);
  for (const spec of root.descendantsOfType("var_spec")) {
    const declaration = spec.parent?.type === "var_declaration" ? spec.parent : spec.parent?.parent;
    if (declaration?.parent?.type !== "source_file") continue;
    if (!spec.childrenForFieldName("name").some((name) => name.text === expression.text)) continue;
    const type = spec.childForFieldName("type")?.text;
    if (type) return bareType(type);
  }
  return null;
}

// `strings.NewReplacer(".", "_")` → [[".", "_"]].
function replacerPairs(argument: SyntaxNode | undefined): Array<[string, string]> {
  if (argument?.type !== "call_expression") return [];
  const values = (argument.childForFieldName("arguments")?.namedChildren ?? []).map(stringLiteral);
  const pairs: Array<[string, string]> = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    if (values[index] !== null && values[index + 1] !== null) pairs.push([values[index]!, values[index + 1]!]);
  }
  return pairs;
}

function selector(call: SyntaxNode): string | null {
  const callee = call.childForFieldName("function");
  if (callee?.type !== "selector_expression") return null;
  const operand = callee.childForFieldName("operand");
  const field = callee.childForFieldName("field");
  return operand?.type === "identifier" && field ? `${operand.text}.${field.text}` : null;
}

function splitSelector(value: string): [string, string] {
  const dot = value.indexOf(".");
  return [value.slice(0, dot), value.slice(dot + 1)];
}

function stringLiteral(node: SyntaxNode): string | null {
  if (node.type === "interpreted_string_literal" || node.type === "raw_string_literal") return node.text.slice(1, -1);
  return null;
}

// `*config.DB[T]` → `DB`.
function bareType(type: string): string {
  return type.trim().replace(/^\*/u, "").replace(/\[.*$/u, "").split(".").pop()!;
}

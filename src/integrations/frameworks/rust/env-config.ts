import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import { rustAttributesOf, type RustParsePlugin } from "../../languages/rust/parser.js";

// Rust env reads, as USES_ENV from the function that reads (the file for an
// item-level read) to an EnvVar:
//   - `std::env::var("X")`, `env::var_os`, `dotenvy::var` / `dotenv::var`
//     (and a bare `var` imported from `std::env`), and the compile-time
//     `env!("X")` / `option_env!("X")`;
//   - clap: `#[arg(env = "X")]` / bare `#[arg(env)]` (the field name upper-
//     cased) on a derive struct, read by the function that parses it, else by
//     the file; and the builder's `Arg::new("x").env("X")`;
//   - envy: the fields of the same-file struct `envy::from_env::<T>()`,
//     `envy::prefixed("APP_").from_env::<T>()` or a typed `let` fills (upper-
//     cased, `#[serde(rename = "x")]` honored);
//   - the config crate: `Environment::with_prefix("APP")` / `.prefix`,
//     `.separator("__")`, the `get_string("a.b")`-style reads and the fields
//     of a same-file struct `try_deserialize::<T>()` fills.
// The variables `.env` files declare come from the language-neutral env files
// contributor, which also covers dotenvy / dotenv loading.

type EnvRead = { name: string; line: number; access: string };
type Struct = { fields: Array<{ name: string; type: string; rename: string | null; line: number; attrs: ReturnType<typeof rustAttributesOf> }> };

const ENV_FUNCTIONS = new Set(["std::env::var", "env::var", "std::env::var_os", "env::var_os", "dotenvy::var", "dotenv::var"]);
const CONFIG_GETTERS = new Set(["get_string", "get_int", "get_float", "get_bool", "get_array", "get_table"]);
const NAME = /^[A-Za-z_]\w*$/u;

export const rustEnvConfigPlugin: RustParsePlugin = ({ fileNodeId, root, nodes, relationships, functions }) => {
  const source = root.text;
  if (!/\benv\b|\bdotenvy?\b|\bclap\b|\benvy\b|\bconfig\b/u.test(source)) return;

  const owners = functions
    .filter((fn) => typeof fn.node.properties.line === "number" && typeof fn.node.properties.endLine === "number")
    .map((fn) => ({ id: fn.node.id, line: Number(fn.node.properties.line), endLine: Number(fn.node.properties.endLine) }));
  const ownerOf = (line: number) => owners
    .filter((owner) => owner.line <= line && line <= owner.endLine)
    .sort((left, right) => (left.endLine - left.line) - (right.endLine - right.line))[0]?.id ?? fileNodeId;

  const constants = new Map<string, string>();
  for (const item of root.descendantsOfType("const_item")) {
    const name = item.childForFieldName("name")?.text;
    const value = item.childForFieldName("value");
    const literal = value ? stringLiteral(value, new Map()) : null;
    if (name && literal !== null) constants.set(name, literal);
  }

  const reads = new Map<string, EnvRead[]>();
  const read = (sourceId: string, entry: EnvRead) => {
    if (!NAME.test(entry.name)) return;
    reads.set(sourceId, [...reads.get(sourceId) ?? [], entry]);
  };

  const bareVar = /\buse\s+std::env::(?:var|var_os)\b|\buse\s+std::env::\{[^}]*\bvar(?:_os)?\b/u.test(source);
  const structs = structTypes(root);
  const hasConfig = /\bconfig\b/u.test(source) && /\bEnvironment\b/u.test(source);
  const settings = { prefix: null as string | null, prefixSeparator: "_", separator: null as string | null };

  // Config builder settings of the file.
  if (hasConfig) {
    for (const call of root.descendantsOfType("call_expression")) {
      const callee = normalize(call.childForFieldName("function")?.text ?? "");
      const args = argumentsOf(call);
      const first = args[0] ? stringLiteral(args[0], constants) : null;
      if (first === null) continue;
      if (/(?:^|::)Environment::with_prefix$/u.test(callee) || /\.prefix$/u.test(callee)) settings.prefix = first;
      else if (/\.prefix_separator$/u.test(callee)) settings.prefixSeparator = first;
      else if (/\.separator$/u.test(callee)) settings.separator = first;
    }
  }
  const configName = (key: string): string | null => {
    const body = key.includes(".") ? (settings.separator === null ? null : key.split(".").join(settings.separator)) : key;
    if (body === null) return null;
    return (settings.prefix === null ? body : `${settings.prefix}${settings.prefixSeparator}${body}`).toUpperCase();
  };

  const parsed: Array<{ type: string; source: string; kind: "clap" | "envy" | "config"; prefix?: string }> = [];

  for (const call of root.descendantsOfType("call_expression")) {
    const callee = normalize(call.childForFieldName("function")?.text ?? "");
    const args = argumentsOf(call);
    const line = call.startPosition.row + 1;
    const first = args[0] ? stringLiteral(args[0], constants) : null;

    if (ENV_FUNCTIONS.has(callee) || (bareVar && (callee === "var" || callee === "var_os"))) {
      if (first !== null) read(ownerOf(line), { name: first, line, access: callee.replace(/^std::/u, "") });
      continue;
    }
    // clap builder: `Arg::new("x").env("X")`.
    if (/\.env$/u.test(callee) && first !== null && /\bArg::new\b/u.test(call.text)) {
      read(ownerOf(line), { name: first, line, access: "clap env" });
      continue;
    }
    // envy.
    const envy = /(?:^|\.|::)from_env(?:::<\s*([\w:]+)[^>]*>)?$/u.exec(callee);
    if (envy && /\benvy\b/u.test(source)) {
      const type = envy[1] ? bareType(envy[1]) : letType(call);
      const prefix = /\.prefixed\(\s*"([^"]*)"\s*\)/u.exec(call.text)?.[1] ?? /envy::prefixed\(\s*"([^"]*)"\s*\)/u.exec(call.text)?.[1] ?? "";
      if (type) parsed.push({ type, source: ownerOf(line), kind: "envy", prefix });
      continue;
    }
    if (hasConfig) {
      const method = /\.(\w+)(?:::<[^>]*>)?$/u.exec(callee)?.[1];
      if (method && (CONFIG_GETTERS.has(method) || (method === "get" && /::</u.test(callee))) && first !== null) {
        const name = configName(first);
        if (name !== null) read(ownerOf(line), { name, line, access: `config ${method}` });
      } else if (method === "try_deserialize" || method === "try_into") {
        const turbofish = /::<\s*([\w:]+)/u.exec(callee)?.[1];
        const type = turbofish ? bareType(turbofish) : letType(call);
        if (type) parsed.push({ type, source: ownerOf(line), kind: "config" });
      }
    }
  }

  // `env!("X")` and `option_env!("X")`.
  for (const macro of root.descendantsOfType("macro_invocation")) {
    const name = normalize(macro.childForFieldName("macro")?.text ?? "");
    if (!/^(?:std::)?(?:option_)?env$/u.test(name)) continue;
    const tokens = macro.namedChildren.find((child) => child.type === "token_tree");
    const literal = tokens?.namedChildren.find((child) => child.type === "string_literal" || child.type === "raw_string_literal");
    const value = literal ? stringLiteral(literal, constants) : null;
    if (value === null) continue;
    const line = macro.startPosition.row + 1;
    read(ownerOf(line), { name: value, line, access: name.replace(/^std::/u, "") + "!" });
  }

  // clap derive: `env` on a field's `arg` / `clap` attribute.
  const clapStructs: Array<{ type: string; names: EnvRead[] }> = [];
  for (const [type, struct] of structs) {
    const names: EnvRead[] = [];
    for (const field of struct.fields) {
      for (const attribute of field.attrs) {
        if (attribute.name !== "arg" && attribute.name !== "clap") continue;
        for (const argument of attribute.args) {
          const match = /^env(?:\s*=\s*(.+))?$/su.exec(argument.trim());
          if (!match) continue;
          const value = match[1] === undefined ? field.name.toUpperCase() : stringLiteralText(match[1].trim(), constants);
          if (value !== null) names.push({ name: value, line: field.line, access: "clap env" });
        }
      }
    }
    if (names.length > 0) clapStructs.push({ type, names });
  }
  if (clapStructs.length > 0) {
    // `Cli::parse()` / `parse_from` / `try_parse` of the struct, else the file.
    for (const call of root.descendantsOfType("call_expression")) {
      const callee = normalize(call.childForFieldName("function")?.text ?? "");
      const match = /^(\w+)::(?:parse|parse_from|try_parse|try_parse_from)$/u.exec(callee);
      if (match && clapStructs.some((entry) => entry.type === match[1])) parsed.push({ type: match[1]!, source: ownerOf(call.startPosition.row + 1), kind: "clap" });
    }
  }

  for (const entry of parsed) {
    if (entry.kind === "clap") {
      for (const item of clapStructs.find((candidate) => candidate.type === entry.type)?.names ?? []) read(entry.source, item);
    } else if (entry.kind === "envy") {
      for (const item of fieldNames(entry.type, entry.prefix ?? "", structs, "_", 0, "envy", (name, prefix) => `${prefix}${name}`.toUpperCase())) read(entry.source, item);
    } else if (settings.separator !== null || settings.prefix !== null || hasConfig) {
      for (const item of fieldNames(entry.type, "", structs, settings.separator ?? "_", 0, "config try_deserialize", (name, prefix) => configName(prefix === "" ? name : `${prefix}.${name}`) ?? "")) read(entry.source, item);
    }
  }
  // A derive struct nobody parses in the file still declares what it reads.
  for (const { type, names } of clapStructs) {
    if (parsed.some((entry) => entry.kind === "clap" && entry.type === type)) continue;
    for (const item of names) read(fileNodeId, item);
  }

  // Each read is the file's too, as for Go and JS.
  const seen = new Set<string>();
  const added = new Set<string>();
  for (const [sourceId, entries] of reads) {
    for (const entry of entries) {
      for (const from of sourceId === fileNodeId ? [sourceId] : [sourceId, fileNodeId]) {
        const key = `${from}\0${entry.name}\0${entry.line}\0${entry.access}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!added.has(entry.name)) {
          added.add(entry.name);
          nodes.push(envVarNode(entry.name));
        }
        relationships.push({ from, to: `env:${entry.name}`, type: "USES_ENV", properties: { line: entry.line, access: entry.access } });
      }
    }
  }
};

function envVarNode(name: string): GraphNode {
  return { id: `env:${name}`, label: "EnvVar", properties: { name } };
}

// The environment names the fields of a struct stand for, nested structs
// below their field name (`db.url` for the config crate, `DB_URL` for envy).
function fieldNames(
  type: string,
  prefix: string,
  structs: Map<string, Struct>,
  separator: string,
  depth: number,
  access: string,
  name: (field: string, prefix: string) => string,
): EnvRead[] {
  const struct = structs.get(type);
  if (!struct || depth > 3) return [];
  const result: EnvRead[] = [];
  for (const field of struct.fields) {
    const key = field.rename ?? field.name;
    const inner = structs.get(bareType(field.type));
    if (inner && access !== "envy") {
      result.push(...fieldNames(bareType(field.type), prefix === "" ? key : `${prefix}.${key}`, structs, separator, depth + 1, access, name));
      continue;
    }
    const value = name(key, prefix);
    if (value !== "") result.push({ name: value, line: field.line, access });
  }
  return result;
}

// The file's struct items by name, with each field's attributes.
function structTypes(root: SyntaxNode): Map<string, Struct> {
  const structs = new Map<string, Struct>();
  for (const item of root.descendantsOfType("struct_item")) {
    const name = item.childForFieldName("name")?.text;
    const body = item.childForFieldName("body");
    if (!name || body?.type !== "field_declaration_list") continue;
    const fields: Struct["fields"] = [];
    for (const declaration of body.namedChildren) {
      if (declaration.type !== "field_declaration") continue;
      const fieldName = declaration.childForFieldName("name")?.text;
      if (!fieldName) continue;
      const attrs = rustAttributesOf(declaration);
      let rename: string | null = null;
      for (const attribute of attrs) {
        if (attribute.name !== "serde") continue;
        for (const argument of attribute.args) {
          const match = /^rename\s*=\s*"([^"]*)"$/u.exec(argument.trim());
          if (match) rename = match[1]!;
        }
      }
      fields.push({ name: fieldName.replace(/^r#/u, ""), type: declaration.childForFieldName("type")?.text ?? "", rename, line: declaration.startPosition.row + 1, attrs });
    }
    structs.set(name, { fields });
  }
  return structs;
}

// `let settings: Settings = ...` / `Result<Settings, _>` around a call.
function letType(call: SyntaxNode): string | null {
  for (let parent = call.parent; parent; parent = parent.parent) {
    if (parent.type === "let_declaration") {
      const text = parent.childForFieldName("type")?.text ?? "";
      const match = /(?:Result|Option)?<?\s*([A-Z]\w*)/u.exec(text.replace(/^(?:anyhow::)?Result</u, ""));
      return match ? match[1]! : null;
    }
    if (parent.type === "function_item" || parent.type === "block") break;
  }
  return null;
}

function argumentsOf(call: SyntaxNode): SyntaxNode[] {
  return call.childForFieldName("arguments")?.namedChildren.filter((child) => child.type !== "line_comment" && child.type !== "block_comment") ?? [];
}

function normalize(text: string): string {
  return text.replace(/\s+/gu, "");
}

function bareType(type: string): string {
  return type.trim().replace(/<.*$/su, "").split("::").pop()!;
}

function stringLiteralText(text: string, constants: Map<string, string>): string | null {
  const plain = /^"((?:[^"\\]|\\.)*)"$/su.exec(text);
  if (plain) return plain[1]!.includes("\\") ? null : plain[1]!;
  const raw = /^r(#*)"(.*)"\1$/su.exec(text);
  if (raw) return raw[2]!;
  return constants.get(text.replace(/^(?:\w+::)*/u, "")) ?? null;
}

function stringLiteral(node: SyntaxNode, constants: Map<string, string>): string | null {
  if (node.type === "reference_expression") {
    const value = node.childForFieldName("value");
    return value ? stringLiteral(value, constants) : null;
  }
  if (node.type === "string_literal" || node.type === "raw_string_literal") return stringLiteralText(node.text, constants);
  if (node.type === "identifier" || node.type === "scoped_identifier") return constants.get(node.text.replace(/^(?:\w+::)*/u, "")) ?? null;
  return null;
}

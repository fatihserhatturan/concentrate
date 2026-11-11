import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { PythonParsePlugin } from "../../languages/python/parser.js";
import { walk } from "../../languages/tree-sitter-utils.js";
import type { PythonContext } from "./context.js";
import { argsOf, compact, createOwnerOf, lastSegment, parameterTypes, stringConstants, stringOnly, unwrap } from "./syntax.js";

// Python env reads, as USES_ENV from the function that reads (the file for a
// module-level read) to an EnvVar:
//   - `os.environ["X"]`, `os.environ.get("X")`, `.setdefault`, `.pop`,
//     `"X" in os.environ`, `os.getenv("X")` / `os.getenvb` (and a bare
//     `environ` / `getenv` imported from `os`);
//   - python-dotenv: `dotenv_values()["X"]` / `.get("X")` and
//     `get_key(path, "X")`;
//   - environs, django-environ and python-decouple: `env("X")`,
//     `env.str("X")`, `env.int("X")`, … on an `Env()` / `environ.Env()` /
//     `AutoConfig()` object, and `config("X", cast=…)` from decouple;
//   - pydantic `BaseSettings` / pydantic-settings: the fields of a settings
//     class are read where the class is instantiated (`Settings()`, also
//     through `get_settings()`), named `<env_prefix><FIELD>` upper-cased, or
//     by `Field(env=…)` / `alias` / `validation_alias` (a prefix does not
//     apply to those); `env_prefix` is read from `model_config =
//     SettingsConfigDict(…)` and v1 `class Config`, and inherited. A
//     `settings.FIELD` read of an instance (a module variable or a parameter
//     typed with the class) reads that field's variables too;
//   - Django `settings.X`: reads the variables the settings module's
//     `X = os.environ[…]` / `env("…")` assignment reads.
// A key that is a constant of another file is resolved once every file is
// parsed. `.env` files come from the language-neutral env files contributor.

type EnvRead = { owner: string; name: string; line: number; access: string };
type Pending = { owner: string; constant: string; line: number; access: string };
type SettingsField = { name: string; line: number; envs: string[] | null };
type SettingsClass = { name: string; line: number; bases: string[]; prefix: string | null; fields: SettingsField[] };
type Assignment = { name: string; line: number; endLine: number };
type SettingsUse = { owner: string; name: string; line: number; root: string; type: string | null };

export type PyEnvFacts = {
  pending: Pending[];
  classes: SettingsClass[];
  // Module-level `NAME = …` and the env names read on its lines (`reads`).
  assignments: Assignment[];
  reads: Array<{ name: string; line: number }>;
  uses: SettingsUse[];
  // The file imports Django's `settings`.
  djangoSettings: boolean;
};

const NAME = /^[A-Za-z_]\w*$/u;
const ENV_METHODS = new Set(["get", "setdefault", "pop"]);
const ENV_CLASSES = new Set(["Env", "AutoConfig", "Config", "RepositoryEnv"]);
const SKIPPED_METHODS = new Set(["read_env", "prefixed", "add_parser", "seal", "dump", "parser_for", "add_parser_from_field", "clone"]);
const SETTINGS_ROOT = /^(?:settings|config|conf|cfg|app_settings|app_config)$/u;
const ENV_SIGNAL = /\benviron\b|\bgetenv\b|\bgetenvb\b|\bdotenv|\bdecouple\b|\benvs?\b|\bBaseSettings\b|\bSettings\b|\bsettings\b|\bAutoConfig\b|\bSettingsConfigDict\b/u;

export const pythonEnvPlugin: PythonParsePlugin = ({ fileNodeId, root, nodes, relationships, functions }) => {
  const source = root.text;
  if (!ENV_SIGNAL.test(source)) return;
  const fileNode = nodes.find((node) => node.id === fileNodeId);
  if (!fileNode) return;
  const ownerOf = createOwnerOf(fileNodeId, functions);
  const constants = stringConstants(root);

  const bareEnviron = /\bfrom\s+os\s+import\b[^\n]*\benviron\b/u.test(source);
  const bareGetenv = /\bfrom\s+os\s+import\b[^\n]*\bgetenvb?\b/u.test(source);
  // `from decouple import config` (also `config as cfg`).
  const bareConfig = new Set<string>();
  for (const match of source.matchAll(/^\s*from\s+decouple\s+import\s+([^\n(]+)/gmu)) {
    for (const part of match[1]!.split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/u);
      if (name === "config") bareConfig.add(alias ?? "config");
    }
  }
  const bareGetKey = /\bfrom\s+dotenv\s+import\b[^\n]*\bget_key\b/u.test(source);
  const djangoSettings = /\bfrom\s+django\.conf\s+import\b[^\n]*\bsettings\b/u.test(source);
  const usesEnvObjects = /\benvirons?\b|\bdecouple\b|\bdotenv\b|\bdjango-?environ\b/u.test(source);

  // Names bound to an env reader: `env = Env()`, `config = AutoConfig()`, `values = dotenv_values()`.
  const envObjects = new Set<string>();
  const dotenvObjects = new Set<string>();
  if (usesEnvObjects) {
    walk(root, (node) => {
      if (node.type !== "assignment") return;
      const left = node.childForFieldName("left");
      const right = unwrap(node.childForFieldName("right"));
      if (left?.type !== "identifier" || right?.type !== "call") return;
      const callee = lastSegment(compact(right.childForFieldName("function")?.text ?? ""));
      if (ENV_CLASSES.has(callee) && /\benviron\b|\benvirons\b|\bdecouple\b/u.test(source)) envObjects.add(left.text);
      else if (callee === "dotenv_values") dotenvObjects.add(left.text);
    });
  }

  const reads: EnvRead[] = [];
  const pending: Pending[] = [];
  const read = (node: SyntaxNode, keyNode: SyntaxNode | undefined, access: string) => {
    if (!keyNode) return;
    const line = node.startPosition.row + 1;
    const owner = ownerOf(line);
    const value = stringOnly(keyNode, constants);
    if (value !== null) {
      if (NAME.test(value)) reads.push({ owner, name: value, line, access });
      return;
    }
    const constant = constantName(keyNode);
    if (constant) pending.push({ owner, constant, line, access });
  };

  const isEnviron = (node: SyntaxNode | null | undefined): boolean => {
    const text = compact(node?.text ?? "");
    return text === "os.environ" || text === "os.environb" || (bareEnviron && text === "environ");
  };

  walk(root, (node) => {
    if (node.type === "subscript") {
      // `os.environ["X"] = v` writes.
      if (node.parent?.type === "assignment" && node.parent.childForFieldName("left")?.id === node.id) return;
      const value = node.childForFieldName("value");
      const key = node.childForFieldName("subscript") ?? undefined;
      if (isEnviron(value)) read(node, key, "os.environ");
      else if (value?.type === "identifier" && dotenvObjects.has(value.text)) read(node, key, "dotenv_values");
      return;
    }
    if (node.type === "comparison_operator") {
      const operators = node.children.filter((child) => !child.isNamed).map((child) => child.text).join(" ");
      const [left, right] = node.namedChildren;
      if (/\bin\b/u.test(operators) && isEnviron(right)) read(node, left, "os.environ in");
      return;
    }
    if (node.type !== "call") return;
    const callee = node.childForFieldName("function");
    if (!callee) return;
    const text = compact(callee.text);
    const { positional, keywords } = argsOf(node);
    const first = positional[0] ?? keywords.get("key") ?? keywords.get("name");

    if (callee.type === "attribute") {
      const method = callee.childForFieldName("attribute")?.text ?? "";
      const object = callee.childForFieldName("object");
      if (isEnviron(object) && ENV_METHODS.has(method)) {
        read(node, first, `os.environ.${method}`);
        return;
      }
      if (object?.type === "identifier" && dotenvObjects.has(object.text) && method === "get") {
        read(node, first, "dotenv_values.get");
        return;
      }
      if (object?.type === "identifier" && envObjects.has(object.text) && !SKIPPED_METHODS.has(method)) {
        read(node, first, `env.${method}`);
        return;
      }
      if (text === "os.getenv" || text === "os.getenvb") {
        read(node, first, "os.getenv");
        return;
      }
      if (text === "dotenv.get_key" || text === "dotenv.main.get_key") {
        read(node, positional[1] ?? keywords.get("key_to_get"), "get_key");
        return;
      }
      if (text === "decouple.config") {
        read(node, first, "decouple config");
        return;
      }
      return;
    }
    if (callee.type !== "identifier") return;
    if (text === "getenv" && bareGetenv) read(node, first, "os.getenv");
    else if (text === "get_key" && bareGetKey) read(node, positional[1] ?? keywords.get("key_to_get"), "get_key");
    else if (bareConfig.has(text)) read(node, first, "decouple config");
    else if (envObjects.has(text)) read(node, first, "env");
  });

  const facts: PyEnvFacts = { pending, classes: [], assignments: [], reads: [], uses: [], djangoSettings };

  // Settings classes (resolved to BaseSettings subclasses by the contributor).
  for (const definition of root.descendantsOfType("class_definition")) {
    const name = definition.childForFieldName("name")?.text;
    const body = definition.childForFieldName("body");
    if (!name || !body) continue;
    const bases = (definition.childForFieldName("superclasses")?.namedChildren ?? []).filter((base) => base.type !== "keyword_argument").map((base) => compact(base.text));
    if (!bases.some((base) => /(?:^|\.)(?:BaseSettings|\w*Settings)$/u.test(base))) continue;
    facts.classes.push({ name, line: definition.startPosition.row + 1, bases, prefix: envPrefix(body, constants), fields: settingsFields(body, constants) });
  }

  // Module-level assignments, to map `settings.X` to what the settings module reads for it.
  if (djangoSettings || /\bsettings\b/u.test(fileNode.properties.relativePath as string)) {
    for (const statement of root.namedChildren) {
      const assignment = statement.type === "expression_statement" ? statement.namedChildren[0] : null;
      if (assignment?.type !== "assignment") continue;
      const left = assignment.childForFieldName("left");
      if (left?.type === "identifier" && /^[A-Z][A-Z0-9_]*$/u.test(left.text)) facts.assignments.push({ name: left.text, line: statement.startPosition.row + 1, endLine: statement.endPosition.row + 1 });
    }
    if (facts.assignments.length > 0) facts.reads = reads.map((entry) => ({ name: entry.name, line: entry.line }));
  }

  // `settings.X` (or any `<root>.UPPER`) reads of an instance or of Django's settings.
  const typesOf = new Map<string, Map<string, string>>();
  for (const fn of functions) typesOf.set(fn.node.id, parameterTypes(fn.syntax));
  walk(root, (node) => {
    if (node.type !== "attribute") return;
    const object = node.childForFieldName("object");
    const attribute = node.childForFieldName("attribute")?.text;
    if (object?.type !== "identifier" || !attribute) return;
    if (node.parent?.type === "assignment" && node.parent.childForFieldName("left")?.id === node.id) return;
    if (!(SETTINGS_ROOT.test(object.text) || /^[A-Z][A-Z0-9_]*$/u.test(attribute))) return;
    if (object.text === "os" || object.text === "self" || object.text === "cls") return;
    const line = node.startPosition.row + 1;
    const owner = ownerOf(line);
    facts.uses.push({ owner, name: attribute, line, root: object.text, type: typesOf.get(owner)?.get(object.text) ?? null });
  });

  const written = new Set<string>();
  for (const entry of reads) {
    for (const from of entry.owner === fileNodeId ? [fileNodeId] : [entry.owner, fileNodeId]) {
      const key = `${from}\0${entry.name}\0${entry.line}\0${entry.access}`;
      if (written.has(key)) continue;
      written.add(key);
      if (!nodes.some((candidate) => candidate.id === `env:${entry.name}`)) nodes.push(envVarNode(entry.name));
      relationships.push({ from, to: `env:${entry.name}`, type: "USES_ENV", properties: { line: entry.line, access: entry.access } });
    }
  }

  if (facts.pending.length > 0 || facts.classes.length > 0 || facts.assignments.length > 0 || facts.uses.length > 0) fileNode.properties.pyEnv = JSON.stringify(facts);
};

function envVarNode(name: string): GraphNode {
  return { id: `env:${name}`, label: "EnvVar", properties: { name } };
}

// The constant an env key argument names: `KEY`, `keys.KEY`.
function constantName(node: SyntaxNode): string | null {
  const current = unwrap(node);
  if (current?.type === "identifier" || current?.type === "attribute") {
    const name = lastSegment(compact(current.text));
    return /^[A-Z][A-Z0-9_]*$/u.test(name) ? name : null;
  }
  return null;
}

// `env_prefix` of `model_config = SettingsConfigDict(env_prefix="X_")`, a
// `dict(...)` / `{...}` and v1's `class Config: env_prefix = "x_"`.
function envPrefix(body: SyntaxNode, constants: ReadonlyMap<string, string>): string | null {
  for (const statement of body.namedChildren) {
    const assignment = statement.type === "expression_statement" ? statement.namedChildren[0] : null;
    if (assignment?.type === "assignment" && assignment.childForFieldName("left")?.text === "model_config") {
      const value = unwrap(assignment.childForFieldName("right"));
      if (value?.type === "call") {
        const prefix = argsOf(value).keywords.get("env_prefix");
        if (prefix) return stringOnly(prefix, constants);
      } else if (value?.type === "dictionary") {
        for (const pair of value.namedChildren) {
          if (pair.type === "pair" && stringOnly(pair.childForFieldName("key")) === "env_prefix") return stringOnly(pair.childForFieldName("value"), constants);
        }
      }
    }
    if (statement.type === "class_definition" && statement.childForFieldName("name")?.text === "Config") {
      for (const inner of statement.childForFieldName("body")?.namedChildren ?? []) {
        const innerAssignment = inner.type === "expression_statement" ? inner.namedChildren[0] : null;
        if (innerAssignment?.type === "assignment" && innerAssignment.childForFieldName("left")?.text === "env_prefix") return stringOnly(innerAssignment.childForFieldName("right"), constants);
      }
    }
  }
  return null;
}

// The annotated fields of a settings class: `name: T = default` and
// `name: T = Field(env=…, alias=…, validation_alias=…)`.
function settingsFields(body: SyntaxNode, constants: ReadonlyMap<string, string>): SettingsField[] {
  const fields: SettingsField[] = [];
  for (const statement of body.namedChildren) {
    const assignment = statement.type === "expression_statement" ? statement.namedChildren[0] : null;
    if (assignment?.type !== "assignment") continue;
    const left = assignment.childForFieldName("left");
    const type = assignment.childForFieldName("type")?.text ?? "";
    if (left?.type !== "identifier" || left.text.startsWith("_") || left.text === "model_config" || /\bClassVar\b/u.test(type)) continue;
    if (!assignment.childForFieldName("type")) {
      // Unannotated: only a `Field(...)` is a field.
      const value = unwrap(assignment.childForFieldName("right"));
      if (value?.type !== "call" || lastSegment(compact(value.childForFieldName("function")?.text ?? "")) !== "Field") continue;
    }
    let envs: string[] | null = null;
    const value = unwrap(assignment.childForFieldName("right"));
    if (value?.type === "call" && /^(?:Field|\w*Field)$/u.test(lastSegment(compact(value.childForFieldName("function")?.text ?? "")))) {
      const keywords = argsOf(value).keywords;
      for (const key of ["env", "validation_alias", "alias"]) {
        const node = keywords.get(key);
        if (!node) continue;
        const names = aliasNames(node, constants);
        if (names.length > 0) {
          envs = names;
          break;
        }
      }
    }
    fields.push({ name: left.text, line: statement.startPosition.row + 1, envs });
  }
  return fields;
}

// `"X"`, `["A", "B"]`, `AliasChoices("a", "b")`.
function aliasNames(node: SyntaxNode, constants: ReadonlyMap<string, string>): string[] {
  const current = unwrap(node);
  if (!current) return [];
  const direct = stringOnly(current, constants);
  if (direct !== null) return NAME.test(direct) ? [direct] : [];
  if (current.type === "list" || current.type === "tuple") return current.namedChildren.flatMap((child) => aliasNames(child, constants));
  if (current.type === "call" && lastSegment(compact(current.childForFieldName("function")?.text ?? "")) === "AliasChoices") return argsOf(current).positional.flatMap((child) => aliasNames(child, constants));
  return [];
}

// ---- contributor ----------------------------------------------------------

const upper = (name: string) => name.toUpperCase();

export function addPythonEnv(context: PythonContext): void {
  const { graph, index } = context;
  const files = graph.nodes.filter((node) => node.label === "File" && context.envByFile.has(node.id));
  if (files.length === 0) return;
  const known = new Set(graph.nodes.filter((node) => node.label === "EnvVar").map((node) => node.id));
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];
  const seen = new Set<string>();
  const use = (owner: string, fileId: string, name: string, line: number, access: string) => {
    if (!NAME.test(name)) return;
    const id = `env:${name}`;
    if (!known.has(id)) {
      known.add(id);
      nodes.push(envVarNode(name));
    }
    for (const from of owner === fileId ? [owner] : [owner, fileId]) {
      const key = `${from}\0${name}\0${line}\0${access}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relationships.push({ from, to: id, type: "USES_ENV", properties: { line, access } });
    }
  };

  // Keys that are constants of another file.
  for (const file of files) {
    const facts = context.envByFile.get(file.id)!;
    for (const entry of facts.pending) {
      const variableId = index.lookupVariable(entry.constant, file.id);
      const value = variableId ? index.variablesById.get(variableId)?.properties.stringValue : undefined;
      if (typeof value === "string") use(entry.owner, file.id, value, entry.line, entry.access);
    }
  }

  // Settings classes: the ones that reach BaseSettings, with the prefix of the nearest class that sets one.
  type Settings = { id: string; fileId: string; prefix: string; fields: Array<{ name: string; envs: string[] }> };
  const settingsByClass = new Map<string, Settings>();
  const classIdOf = (name: string, fileId: string) => index.classByFileAndName.get(fileId)?.get(name) ?? null;
  const declared = new Map<string, { facts: SettingsClass; fileId: string }>();
  for (const file of files) for (const cls of context.envByFile.get(file.id)!.classes) {
    const id = classIdOf(cls.name, file.id);
    if (id) declared.set(id, { facts: cls, fileId: file.id });
  }
  for (const [id, { facts, fileId }] of declared) {
    const chain = context.classChain(id);
    if (!chain.bases.has("BaseSettings") && !facts.bases.some((base) => lastSegment(base) === "BaseSettings")) continue;
    let prefix = "";
    let prefixFound = false;
    const fields = new Map<string, { name: string; envs: string[] }>();
    // The class first, then its bases: a field of a subclass wins, and so does its prefix.
    for (const classId of chain.ids) {
      const entry = declared.get(classId);
      if (!entry) continue;
      if (!prefixFound && entry.facts.prefix !== null) {
        prefix = entry.facts.prefix;
        prefixFound = true;
      }
    }
    for (const classId of chain.ids) {
      const entry = declared.get(classId);
      if (!entry) continue;
      for (const field of entry.facts.fields) {
        if (fields.has(field.name)) continue;
        fields.set(field.name, { name: field.name, envs: field.envs ?? [upper(`${prefix}${field.name}`)] });
      }
    }
    settingsByClass.set(id, { id, fileId, prefix, fields: [...fields.values()] });
  }

  if (settingsByClass.size > 0) {
    const names = new Set([...settingsByClass.keys()].map((id) => String(context.nodeById.get(id)?.properties.name)));
    // Where a settings class is instantiated, its fields are read.
    const relationshipIndex = context.relationshipIndex;
    for (const call of graph.nodes) {
      if (call.label !== "Call" || typeof call.properties.callee !== "string" || call.properties.receiver) continue;
      if (!names.has(call.properties.callee)) continue;
      const functionId = relationshipIndex.callerFunctionByCallId.get(call.id);
      const fileId = relationshipIndex.callerFileByModuleCallId.get(call.id) ?? (functionId ? relationshipIndex.fileByFunctionId.get(functionId) : undefined);
      if (!fileId) continue;
      const classId = index.lookupType(call.properties.callee, fileId);
      const settings = classId ? settingsByClass.get(classId) : undefined;
      if (!settings) continue;
      for (const field of settings.fields) for (const env of field.envs) use(functionId ?? fileId, fileId, env, Number(call.properties.line), "pydantic settings");
    }
  }

  // `settings.X` of Django's settings, and of an instance of a settings class.
  const djangoEnv = new Map<string, Set<string>>();
  for (const file of files) {
    const facts = context.envByFile.get(file.id)!;
    for (const assignment of facts.assignments) {
      for (const entry of facts.reads) {
        if (entry.line < assignment.line || entry.line > assignment.endLine) continue;
        djangoEnv.set(assignment.name, (djangoEnv.get(assignment.name) ?? new Set()).add(entry.name));
      }
    }
  }
  for (const file of files) {
    const facts = context.envByFile.get(file.id)!;
    for (const entry of facts.uses) {
      let settings: Settings | undefined;
      const typeName = entry.type ? entry.type.replace(/^["']|["']$/gu, "").replace(/^Optional\[(.*)\]$/u, "$1") : null;
      if (typeName) {
        const classId = index.lookupType(typeName, file.id);
        settings = classId ? settingsByClass.get(classId) : undefined;
      }
      if (!settings && !entry.type) {
        const variableId = index.lookupVariable(entry.root, file.id);
        const variable = variableId ? index.variablesById.get(variableId) : undefined;
        const variableFile = variableId ? index.fileByVariableId.get(variableId) : undefined;
        const constructed = variable?.properties.constructorName ?? variable?.properties.typeName;
        if (variableFile && typeof constructed === "string") {
          const classId = index.lookupType(constructed, variableFile);
          settings = classId ? settingsByClass.get(classId) : undefined;
        }
      }
      if (settings) {
        const field = settings.fields.find((candidate) => candidate.name === entry.name || upper(candidate.name) === entry.name);
        for (const env of field?.envs ?? []) use(entry.owner, file.id, env, entry.line, `settings.${entry.name}`);
        continue;
      }
      if (facts.djangoSettings && entry.root === "settings") {
        for (const env of djangoEnv.get(entry.name) ?? []) use(entry.owner, file.id, env, entry.line, `settings.${entry.name}`);
      }
    }
  }

  graph.addNodes(nodes);
  graph.addRelationships(relationships);
}

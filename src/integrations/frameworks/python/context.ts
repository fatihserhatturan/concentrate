import type { IGraphContributor } from "../../../core/contracts/graph-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createPythonCallIndex, type PythonCallIndex } from "../../../core/scan/resolution/python-calls.js";
import { readPythonProjects } from "../../languages/python/project.js";
import { createPythonResolver, type PythonResolver } from "../../languages/python/resolution.js";
import type { PyCall, PyFacts, PyList } from "./facts.js";
import type { PyEnvFacts } from "./env-config.js";
import type { PyDataFacts } from "./data-facts.js";
import type { ResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";

export type Decorator = { name: string; args: string[]; kwargs: Record<string, string>; positional: string[]; line: number };

export type PythonContext = {
  graph: IGraphContributor;
  fileIds: Map<string, string>;
  relativeOf: Map<string, string>;
  factsByFile: Map<string, PyFacts>;
  // What the env and data plugins recorded per file (removed from the File nodes).
  envByFile: Map<string, PyEnvFacts>;
  dataByFile: Map<string, PyDataFacts>;
  relationshipIndex: ResolutionRelationshipIndex;
  index: PythonCallIndex;
  resolver: PythonResolver;
  decoratorsOf: (functionId: string) => Decorator[];
  fileOfFunction: (functionId: string) => string | null;
  nodeById: Map<string, GraphNode>;
  // The functions and calls of every file, by file.
  callsByFile: Map<string, Array<PyCall & { fileId: string }>>;
  listsByFile: Map<string, PyList[]>;
  // The method named `name` of the class or the first user base that has it.
  findMethod: (classId: string, name: string) => string | null;
  // The names the class and its bases declare (`methods`) and extend (`bases`).
  classChain: (classId: string) => { methods: Set<string>; bases: Set<string>; ids: string[] };
  literal: (expr: string | null | undefined, fileId: string, scope?: string | null) => string | null;
  // A string the class (or a base) assigns in its body.
  classString: (classId: string, name: string) => string | null;
  literalList: (expr: string | null | undefined) => string[] | null;
};

// Reads every file's `pyFacts` (and removes it), and builds what the framework
// layers resolve names with: the call index of the scan, the import resolver
// and the decorators of each function.
export async function createPythonContext(graph: IGraphContributor, rootPath: string): Promise<PythonContext | null> {
  const factsByFile = new Map<string, PyFacts>();
  const envByFile = new Map<string, PyEnvFacts>();
  const dataByFile = new Map<string, PyDataFacts>();
  const fileIds = new Map<string, string>();
  const relativeOf = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.label !== "File") continue;
    if (typeof node.properties.relativePath === "string") {
      const relative = node.properties.relativePath.split("\\").join("/");
      fileIds.set(relative, node.id);
      relativeOf.set(node.id, relative);
    }
    if (typeof node.properties.pyFacts === "string") {
      factsByFile.set(node.id, JSON.parse(node.properties.pyFacts) as PyFacts);
      delete node.properties.pyFacts;
    }
    if (typeof node.properties.pyEnv === "string") {
      envByFile.set(node.id, JSON.parse(node.properties.pyEnv) as PyEnvFacts);
      delete node.properties.pyEnv;
    }
    if (typeof node.properties.pyData === "string") {
      dataByFile.set(node.id, JSON.parse(node.properties.pyData) as PyDataFacts);
      delete node.properties.pyData;
    }
  }
  const hasPython = [...fileIds.keys()].some((file) => file.endsWith(".py"));
  if (!hasPython) return null;

  const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
  const index = createPythonCallIndex(graph, relationshipIndex);
  const projects = await readPythonProjects(rootPath, fileIds.keys());
  const resolver = createPythonResolver(projects, new Set(fileIds.keys()));

  const nodeById = new Map<string, GraphNode>();
  for (const node of graph.nodes) nodeById.set(node.id, node);

  const decoratorsByFunction = new Map<string, Decorator[]>();
  for (const rel of graph.relationships) {
    if (rel.type !== "HAS_METHOD_DECORATOR") continue;
    const node = nodeById.get(rel.to);
    if (!node || !node.id.includes(":decorator:")) continue;
    const args = typeof node.properties.args === "string" ? JSON.parse(node.properties.args) as string[] : [];
    const { positional, kwargs } = splitArguments(args);
    const list = decoratorsByFunction.get(rel.from) ?? [];
    list.push({ name: String(node.properties.name), args, positional, kwargs, line: Number(node.properties.line) });
    decoratorsByFunction.set(rel.from, list);
  }

  const callsByFile = new Map<string, Array<PyCall & { fileId: string }>>();
  const listsByFile = new Map<string, PyList[]>();
  for (const [fileId, facts] of factsByFile) {
    callsByFile.set(fileId, facts.calls.map((call) => ({ ...call, fileId })));
    listsByFile.set(fileId, facts.lists);
  }

  const classChain: PythonContext["classChain"] = (classId) => {
    const methods = new Set<string>();
    const bases = new Set<string>();
    const ids: string[] = [];
    const visit = (id: string, depth: number) => {
      if (ids.includes(id) || depth > 12) return;
      ids.push(id);
      for (const name of index.methods.get(id)?.keys() ?? []) methods.add(name);
      const extendsNames = nodeById.get(id)?.properties.extendsNames;
      if (typeof extendsNames === "string") for (const name of JSON.parse(extendsNames) as string[]) bases.add(name.split(".").at(-1)!);
      for (const base of index.supers.get(id) ?? []) visit(base, depth + 1);
    };
    visit(classId, 0);
    return { methods, bases, ids };
  };

  const findMethod = (classId: string, name: string): string | null => {
    for (const id of classChain(classId).ids) {
      const found = index.methods.get(id)?.get(name)?.[0];
      if (found) return found;
    }
    return null;
  };

  const classString = (classId: string, name: string): string | null => {
    for (const id of classChain(classId).ids) {
      const owner = index.owners.get(id);
      const className = String(owner?.node.properties.name ?? "");
      const value = owner ? factsByFile.get(owner.fileId)?.classStrings[className]?.[name] : undefined;
      if (value !== undefined) return value;
    }
    return null;
  };

  // The class a called name makes: `Settings()`, or what `get_settings()` is annotated to return.
  const classOfCall = (name: string, fileId: string): string | null => {
    const classId = index.lookupType(name, fileId);
    if (classId) return classId;
    const functionId = index.lookupFunction(name, fileId);
    const returnType = functionId ? index.functionsById.get(functionId)?.properties.returnType : undefined;
    const functionFile = functionId ? index.fileByFunctionId.get(functionId) : undefined;
    if (typeof returnType !== "string" || !functionFile) return null;
    return index.lookupType(returnType.replace(/^["']|["']$/gu, "").replace(/^Optional\[(.*)\]$/u, "$1"), functionFile);
  };

  // A string literal, a module constant, or `settings.api_prefix` where `settings` is an instance of a class that assigns the string.
  const literal = (expr: string | null | undefined, fileId: string, scope: string | null = null): string | null => {
    if (expr === null || expr === undefined) return null;
    const direct = stringLiteral(expr);
    if (direct !== null) return direct;
    if (!/^[A-Za-z_][\w.]*$/u.test(expr)) return null;
    const id = index.lookupVariable(expr, fileId);
    const value = id ? index.variablesById.get(id)?.properties.stringValue : undefined;
    if (typeof value === "string") return value;
    const dot = expr.lastIndexOf(".");
    if (dot < 0) return null;
    const [root, attribute] = [expr.slice(0, dot), expr.slice(dot + 1)];
    let classId: string | null = null;
    const local = scope ? factsByFile.get(fileId)?.localCalls[`${scope}|${root}`] : undefined;
    if (local) classId = classOfCall(local, fileId);
    if (!classId) {
      const variableId = index.lookupVariable(root, fileId);
      const variable = variableId ? index.variablesById.get(variableId) : undefined;
      const variableFile = variableId ? index.fileByVariableId.get(variableId) : undefined;
      const typeName = variable?.properties.typeName ?? variable?.properties.constructorName;
      if (variableFile && typeof typeName === "string") classId = classOfCall(typeName, variableFile);
    }
    return classId ? classString(classId, attribute) : null;
  };

  return {
    graph,
    fileIds,
    relativeOf,
    factsByFile,
    envByFile,
    dataByFile,
    relationshipIndex,
    index,
    resolver,
    decoratorsOf: (functionId) => decoratorsByFunction.get(functionId) ?? [],
    fileOfFunction: (functionId) => relationshipIndex.fileByFunctionId.get(functionId) ?? index.fileByFunctionId.get(functionId) ?? null,
    nodeById,
    callsByFile,
    listsByFile,
    findMethod,
    classChain,
    literal,
    classString,
    literalList: stringList,
  };
}

export function splitArguments(args: readonly string[]): { positional: string[]; kwargs: Record<string, string> } {
  const positional: string[] = [];
  const kwargs: Record<string, string> = {};
  for (const arg of args) {
    const match = /^([A-Za-z_]\w*)\s*=(?!=)\s*([\s\S]*)$/u.exec(arg.trim());
    if (match) kwargs[match[1]!] = match[2]!.trim();
    else positional.push(arg.trim());
  }
  return { positional, kwargs };
}

// A string literal written in source (`"/x"`, `r"^x$"`, `'a' 'b'`); f-strings and
// anything computed are null.
export function stringLiteral(expr: string): string | null {
  const text = expr.trim();
  const pattern = /^([rRuUbB]{0,2})("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')\s*/u;
  let rest = text;
  let value = "";
  let count = 0;
  while (rest !== "") {
    const match = pattern.exec(rest);
    if (!match) return null;
    const raw = /[rR]/u.test(match[1]!);
    const quoted = match[2]!;
    const body = quoted.startsWith('"""') || quoted.startsWith("'''") ? quoted.slice(3, -3) : quoted.slice(1, -1);
    value += raw ? body : body.replace(/\\(["'\\])/gu, "$1").replace(/\\n/gu, "\n");
    rest = rest.slice(match[0].length);
    count += 1;
  }
  return count > 0 ? value : null;
}

// `["GET", "POST"]`, `("get",)`: the string literals of a list or tuple written in source.
export function stringList(expr: string | null | undefined): string[] | null {
  if (!expr) return null;
  const text = expr.trim();
  if (!/^[[(][\s\S]*[\])]$/u.test(text)) return null;
  const values: string[] = [];
  const pattern = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/gu;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) values.push(match[1] ?? match[2] ?? "");
  const stripped = text.slice(1, -1).replace(pattern, "").replace(/[\s,]/gu, "");
  return stripped === "" ? values : null;
}

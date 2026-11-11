import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphRelationship } from "../../../core/graph/model.js";
import type { PythonParsePlugin } from "../../languages/python/parser.js";
import type { PythonContext } from "./context.js";
import { argsOf, compact, lastSegment, unwrap } from "./syntax.js";

// Python dependency injection, as INJECTS between classes (like NestJS
// constructor injection and Go's fx / wire):
//   - dependency-injector: a `DeclarativeContainer` provider
//     `repo = providers.Singleton(UserRepo, db=db)` makes UserRepo INJECT the
//     class the provider `db` builds (`fieldName` the keyword, or the
//     provider's name for a positional argument); a provider of a function
//     (`providers.Callable(make_service, repo=repo)`, `Resource`) builds the
//     class its return annotation names; providers written in place
//     (`providers.Factory(Repo, db=providers.Singleton(Db))`) count too;
//   - FastAPI `Depends`: a provider function that returns a class (its return
//     annotation, `Generator[X]` and `Optional[X]` unwrapped) INJECTS the class
//     each of its `Depends(...)` parameters provides (`Depends(Class)`,
//     `Depends(get_x)` of a function that returns a class, a factory call like
//     `Depends(get_repository(Repo))` of the class it is given, else the
//     parameter's annotation), and so does a class whose `__init__` takes
//     `Depends(...)` parameters.
// The routes' own `Depends` chains are lifecycle steps (routes.ts); this is
// the relation between the classes the providers build.

type Param = { name: string; marker: string; arg: string | null; type: string | null };

const PROVIDERS = new Set([
  "Factory", "Singleton", "ThreadSafeSingleton", "ThreadLocalSingleton", "NonCopyable", "DelegatedFactory", "DelegatedSingleton", "DelegatedThreadSafeSingleton",
  "Callable", "DelegatedCallable", "Coroutine", "Resource", "AsyncResource", "ContextLocalSingleton",
]);

export type PyDiFacts = {
  // The classes each function calls by name (`UserService(repo)`), for providers.
  constructs?: Record<string, string[]>;
  containers: Array<{ name: string; line: number; providers: Array<{ name: string; callee: string; first: string | null; args: Array<{ name: string | null; value: string }>; line: number }> }>;
};

export const pythonDiPlugin: PythonParsePlugin = ({ fileNodeId, root, nodes, functions }) => {
  const fastapi = /\bDepends\b/u.test(root.text);
  if (!fastapi && !/dependency_injector|\bDeclarativeContainer\b/u.test(root.text)) return;
  const containers: PyDiFacts["containers"] = [];
  const constructs: Record<string, string[]> = {};
  if (fastapi) {
    for (const fn of functions) {
      const names = new Set<string>();
      for (const call of fn.syntax.descendantsOfType("call")) {
        const callee = call.childForFieldName("function");
        if (callee?.type === "identifier" && /^[A-Z]/u.test(callee.text)) names.add(callee.text);
      }
      if (names.size > 0) constructs[fn.node.id] = [...names];
    }
  }
  for (const definition of root.descendantsOfType("class_definition")) {
    const name = definition.childForFieldName("name")?.text;
    const body = definition.childForFieldName("body");
    const bases = (definition.childForFieldName("superclasses")?.namedChildren ?? []).map((base) => compact(base.text));
    if (!name || !body || !bases.some((base) => /(?:^|\.)(?:Declarative|Dynamic)Container$/u.test(base))) continue;
    const providers: PyDiFacts["containers"][number]["providers"] = [];
    let anonymous = 0;
    const read = (provider: string, call: SyntaxNode, line: number): void => {
      const callee = compact(call.childForFieldName("function")?.text ?? "");
      if (!PROVIDERS.has(lastSegment(callee))) return;
      const { positional, keywords } = argsOf(call);
      const args: Array<{ name: string | null; value: string }> = [];
      const value = (node: SyntaxNode): string => {
        const inner = unwrap(node);
        if (inner?.type === "call" && PROVIDERS.has(lastSegment(compact(inner.childForFieldName("function")?.text ?? "")))) {
          const inlineName = `<inline:${anonymous++}>`;
          read(inlineName, inner, inner.startPosition.row + 1);
          return inlineName;
        }
        return compact(node.text);
      };
      positional.slice(1).forEach((node) => args.push({ name: null, value: value(node) }));
      for (const [key, node] of keywords) args.push({ name: key, value: value(node) });
      providers.push({ name: provider, callee, first: positional[0] ? compact(positional[0].text) : null, args, line });
    };
    for (const statement of body.namedChildren) {
      const assignment = statement.type === "expression_statement" ? statement.namedChildren[0] : null;
      if (assignment?.type !== "assignment") continue;
      const left = assignment.childForFieldName("left");
      const right = unwrap(assignment.childForFieldName("right"));
      if (left?.type === "identifier" && right?.type === "call") read(left.text, right, statement.startPosition.row + 1);
    }
    if (providers.length > 0) containers.push({ name, line: definition.startPosition.row + 1, providers });
  }
  const file = nodes.find((node) => node.id === fileNodeId);
  if (file && (containers.length > 0 || Object.keys(constructs).length > 0)) file.properties.pyDi = JSON.stringify({ containers, constructs } satisfies PyDiFacts);
};

const bareType = (text: string | null | undefined): string | null => {
  if (!text) return null;
  let current = text.trim().replace(/^["']|["']$/gu, "");
  for (let previous = ""; previous !== current;) {
    previous = current;
    current = current
      .replace(/^(?:typing\.)?(?:Optional|Annotated|Awaitable|Coroutine)\[(.+)\]$/su, (_all, inner: string) => inner.split(/,(?![^[]*\])/u)[0]!.trim())
      .replace(/^(?:typing\.|collections\.abc\.)?(?:Generator|Iterator|AsyncGenerator|AsyncIterator|Iterable|AsyncIterable)\[(.+)\]$/su, (_all, inner: string) => inner.split(/,(?![^[]*\])/u)[0]!.trim())
      .replace(/\s*\|\s*None$/u, "")
      .replace(/^None\s*\|\s*/u, "")
      .trim();
  }
  return /^[A-Za-z_][\w.]*$/u.test(current) && current !== "None" ? current : null;
};

export function addPythonDi(context: PythonContext): void {
  const { graph, index } = context;
  const diByFile = new Map<string, PyDiFacts>();
  const constructed = new Map<string, Set<string>>();
  for (const node of graph.nodes) {
    if (node.label === "File" && typeof node.properties.pyDi === "string") {
      const facts = JSON.parse(node.properties.pyDi) as PyDiFacts;
      diByFile.set(node.id, facts);
      for (const [functionId, names] of Object.entries(facts.constructs ?? {})) constructed.set(functionId, new Set(names));
      delete node.properties.pyDi;
    }
  }
  const relationships: GraphRelationship[] = [];
  const added = new Set<string>();
  const inject = (consumer: string | null, dependency: string | null, fieldName: string) => {
    if (!consumer || !dependency || consumer === dependency) return;
    const key = `${consumer}\0${dependency}\0${fieldName}`;
    if (added.has(key)) return;
    added.add(key);
    relationships.push({ from: consumer, to: dependency, type: "INJECTS", properties: { fieldName } });
  };

  const classOf = (name: string | null, fileId: string): string | null => (name ? index.lookupType(name, fileId) ?? index.lookupType(lastSegment(name), fileId) : null);
  // The class a function builds, from its return annotation.
  const producedBy = (functionId: string | null): string | null => {
    if (!functionId) return null;
    const node = index.functionsById.get(functionId);
    const fileId = index.fileByFunctionId.get(functionId);
    const returned = bareType(typeof node?.properties.returnType === "string" ? node.properties.returnType : null);
    return fileId ? classOf(returned, fileId) : null;
  };

  // ---- dependency-injector ----
  for (const [fileId, facts] of diByFile) {
    for (const container of facts.containers) {
      const providerClass = new Map<string, string | null>();
      const build = (provider: PyDiFacts["containers"][number]["providers"][number]): string | null => {
        const kind = lastSegment(provider.callee);
        const first = provider.first;
        const direct = classOf(first, fileId);
        if (direct) return direct;
        if (!first || /^["']/u.test(first)) return null;
        if (kind === "Callable" || kind === "Resource" || kind === "AsyncResource" || kind === "Coroutine" || kind.startsWith("Delegated")) return producedBy(index.lookupFunction(first, fileId));
        return null;
      };
      for (const provider of container.providers) providerClass.set(provider.name, build(provider));
      for (const provider of container.providers) {
        const consumer = providerClass.get(provider.name) ?? null;
        for (const arg of provider.args) {
          const name = arg.value.replace(/^(?:self|cls|\w+Container)\./u, "");
          const dependency = providerClass.get(name) ?? providerClass.get(arg.value) ?? null;
          inject(consumer, dependency, arg.name ?? name);
        }
      }
    }
  }

  // ---- FastAPI Depends ----
  // The functions some parameter names in `Depends(...)`: the providers.
  const providers = new Set<string>();
  for (const [fileId, facts] of context.factsByFile) {
    for (const params of Object.values(facts.params)) {
      for (const param of params) {
        const expression = param.marker === "alias" ? (param.arg ? context.factsByFile.get(fileId)?.aliases[param.arg] ?? findAlias(context, param.arg, fileId) : undefined)?.arg : param.arg;
        if (!expression || /\(/u.test(expression)) continue;
        const target = index.lookupFunction(expression, fileId);
        if (target) providers.add(target);
      }
    }
  }
  for (const [fileId, facts] of context.factsByFile) {
    for (const [functionId, params] of Object.entries(facts.params)) {
      const dependencies = params.filter((param): param is Param => param.marker === "Depends" || param.marker === "Security" || param.marker === "alias");
      if (dependencies.length === 0) continue;
      const functionNode = index.functionsById.get(functionId);
      // The class that owns the dependencies: an `__init__` makes its class one, a provider the class it returns.
      let consumer: string | null = null;
      if (functionNode?.properties.name === "__init__" && typeof functionNode.properties.className === "string") consumer = index.classByFileAndName.get(fileId)?.get(functionNode.properties.className) ?? null;
      else {
        // A provider builds the class it returns: it calls that class by name.
        if (!providers.has(functionId)) continue;
        consumer = producedBy(functionId);
        const className = consumer ? String(context.nodeById.get(consumer)?.properties.name) : null;
        if (!className || !constructed.get(functionId)?.has(className)) continue;
      }
      if (!consumer) continue;
      for (const param of dependencies) {
        let marker = param;
        if (param.marker === "alias") {
          const alias = param.arg ? context.factsByFile.get(fileId)?.aliases[param.arg] ?? findAlias(context, param.arg, fileId) : undefined;
          if (!alias) continue;
          marker = { ...alias, name: param.name };
        }
        const expression = marker.arg;
        let dependency: string | null = null;
        if (expression) {
          const call = /^([\w.]+)\((.*)\)$/su.exec(expression);
          if (call) {
            // A factory: `get_repository(Repo)` provides the class it is given, else what it returns.
            const argument = call[2]!.split(",")[0]!.trim();
            dependency = classOf(argument, fileId) ?? producedBy(index.lookupFunction(call[1]!, fileId));
          } else {
            dependency = classOf(expression, fileId) ?? producedBy(index.lookupFunction(expression, fileId));
          }
        }
        dependency ??= classOf(bareType(marker.type ?? param.type), fileId);
        inject(consumer, dependency, param.name);
      }
    }
  }

  graph.addRelationships(relationships);
}

function findAlias(context: PythonContext, name: string, fileId: string): Param | undefined {
  const last = lastSegment(name);
  const variableId = context.index.lookupVariable(name, fileId);
  const owner = variableId ? context.index.fileByVariableId.get(variableId) : undefined;
  const found: Param | undefined = owner ? context.factsByFile.get(owner)?.aliases[last] : undefined;
  return found;
}

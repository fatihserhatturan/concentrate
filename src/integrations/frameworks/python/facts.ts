import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { PythonParsePlugin, PythonParsedFunction } from "../../languages/python/parser.js";
import { walk } from "../../languages/tree-sitter-utils.js";

// What a Python file says about routing, commands and settings, in the words
// of its source: the framework calls (`app = Flask(__name__)`,
// `app.register_blueprint(bp, url_prefix="/x")`, `router.register("u", V)`),
// the URL lists (`urlpatterns = [path(...)]`, Starlette `routes=[Route(...)]`),
// the FastAPI parameters that carry `Depends(...)`, and the Django settings
// `MIDDLEWARE` and `ROOT_URLCONF`. Expressions stay text: the contributor
// (routes.ts) resolves them with the names of the whole scan, then removes
// this record from the File node.

export type PyCall = {
  // The function the call is written in, or null at module level.
  scope: string | null;
  // `name = Call(...)`.
  assigned: string | null;
  // The called expression as written: `Flask`, `app.include_router`.
  callee: string;
  args: string[];
  kwargs: Record<string, string>;
  line: number;
  column: number;
};

export type PyListItem =
  // `path("x/", view)`, `Route("/x", endpoint, methods=[..])`.
  | { kind: "route"; callee: string; pattern: string | null; view: string | null; methods: string | null; line: number }
  // `path("api/", include(...))`, `Mount("/p", routes=[..])`: `target` names a module (string literal), a list or an app (expression); `inline` is a list written in place.
  | { kind: "include"; callee: string; pattern: string | null; target: string | null; inline: PyListItem[] | null; line: number }
  // `*router.urls`, `+ router.urls`, `+ other_patterns`.
  | { kind: "ref"; expr: string; line: number };

export type PyList = { scope: string | null; name: string; items: PyListItem[]; line: number };

export type PyParam = { name: string; marker: string; arg: string | null; type: string | null };

export type PyFacts = {
  calls: PyCall[];
  lists: PyList[];
  // FastAPI parameters of functions, by function node id.
  params: Record<string, PyParam[]>;
  // The function a nested function is written in, by function node id.
  nested: Record<string, string>;
  // String values a class body assigns (`API_V1_STR: str = "/api/v1"`, `lookup_field = "slug"`), by class name.
  classStrings: Record<string, Record<string, string>>;
  // Module-level `CurrentUser = Annotated[User, Depends(current_user)]`, by name.
  aliases: Record<string, PyParam>;
  // `settings = get_settings()` inside a function: the called expression, by `function id|name`.
  localCalls: Record<string, string>;
  middleware?: string[];
  rootUrlconf?: string;
};

const interestingCallees = new Set([
  "Flask", "Quart", "Blueprint", "FastAPI", "APIRouter", "Starlette", "Router", "DefaultRouter", "SimpleRouter", "Api", "Typer", "Celery",
  "register_blueprint", "include_router", "mount", "add_url_rule", "add_api_route", "add_api_websocket_route", "add_route", "add_websocket_route",
  "register", "add_resource", "add_command", "add_typer", "run", "send_task",
]);
const listCallees = new Set(["path", "re_path", "url", "Route", "WebSocketRoute", "Mount", "APIRoute", "APIWebSocketRoute"]);
const markers = new Set(["Depends", "Security", "Query", "Path", "Body", "Header", "Cookie", "Form", "File"]);
const relevant = /flask|quart|fastapi|starlette|django|rest_framework|celery|click|typer|urlpatterns|MIDDLEWARE|ROOT_URLCONF|APIRouter|Blueprint/u;

const lastSegment = (name: string) => name.split(".").at(-1) ?? name;
const compact = (text: string) => text.replace(/\s+/gu, " ").trim();

export const pythonFactsPlugin: PythonParsePlugin = ({ fileNodeId, root, nodes, functions }) => {
  const file = nodes.find((node) => node.id === fileNodeId);
  if (!file) return;
  // Settings classes live in files that name no framework: their path-like strings are kept for every file.
  if (!relevant.test(root.text)) {
    const classStrings: PyFacts["classStrings"] = {};
    for (const statement of root.namedChildren) {
      const definition = statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
      if (definition?.type === "class_definition") collectClassStrings(definition, { classStrings } as PyFacts);
    }
    if (Object.keys(classStrings).length > 0) file.properties.pyFacts = JSON.stringify({ calls: [], lists: [], params: {}, nested: {}, classStrings, aliases: {}, localCalls: {} } satisfies PyFacts);
    return;
  }
  const hasAnnotated = /fastapi/iu.test(root.text);
  const facts: PyFacts = { calls: [], lists: [], params: {}, nested: {}, classStrings: {}, aliases: {}, localCalls: {} };

  const scopeOf = (node: SyntaxNode): string | null => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (parent.type === "function_definition") return functions.find((fn) => fn.syntax.id === parent.id)?.node.id ?? null;
    }
    return null;
  };

  const callFact = (call: SyntaxNode, assigned: string | null): PyCall | null => {
    const callee = call.childForFieldName("function");
    if (!callee) return null;
    const calleeText = callee.text.replace(/\s+/gu, "");
    if (!interestingCallees.has(lastSegment(calleeText))) return null;
    const { args, kwargs } = argumentsOf(call);
    const position = callee.type === "attribute" ? (callee.childForFieldName("attribute") ?? call).startPosition : call.startPosition;
    return { scope: scopeOf(call), assigned, callee: calleeText, args, kwargs, line: position.row + 1, column: position.column };
  };

  walk(root, (node) => {
    if (node.type === "call") {
      const parent = node.parent;
      const assigned = parent?.type === "assignment" && parent.childForFieldName("right")?.id === node.id && parent.childForFieldName("left")?.type === "identifier"
        ? parent.childForFieldName("left")!.text
        : null;
      const fact = callFact(node, assigned);
      if (fact) {
        // `Starlette(routes=[...])`, `Router(routes=[...])`: the inline list is a list of its own.
        const routes = node.childForFieldName("arguments")?.namedChildren.find((arg) => arg.type === "keyword_argument" && arg.childForFieldName("name")?.text === "routes")?.childForFieldName("value");
        if (routes && (routes.type === "list" || routes.type === "tuple")) {
          const name = `<list:${routes.startPosition.row + 1}:${routes.startPosition.column}>`;
          facts.lists.push({ scope: fact.scope, name, items: listItems(routes), line: routes.startPosition.row + 1 });
          fact.kwargs.routes = name;
        }
        facts.calls.push(fact);
      }
      const callee = node.childForFieldName("function");
      // `urlpatterns.append(path(..))`, `urlpatterns.extend([..])`.
      if (callee?.type === "attribute" && /^(?:append|extend)$/u.test(callee.childForFieldName("attribute")?.text ?? "")) {
        const target = callee.childForFieldName("object");
        const argument = node.childForFieldName("arguments")?.namedChildren[0];
        if (target?.type === "identifier" && argument) {
          const items = callee.childForFieldName("attribute")!.text === "append" ? listItems(argument, true) : listItems(argument);
          if (items.length > 0) facts.lists.push({ scope: scopeOf(node), name: target.text, items, line: node.startPosition.row + 1 });
        }
      }
    }
  });

  for (const statement of root.namedChildren) {
    collectStatement(statement, null, facts, listItems);
    collectAlias(statement, facts);
    const definition = statement.type === "decorated_definition" ? statement.childForFieldName("definition") : statement;
    if (definition?.type === "class_definition") collectClassStrings(definition, facts);
  }
  for (const fn of functions) {
    const body = fn.syntax.childForFieldName("body");
    if (!body) continue;
    const enclosing = scopeOf(fn.syntax);
    if (enclosing) facts.nested[fn.node.id] = enclosing;
    for (const statement of body.namedChildren) {
      collectStatement(statement, fn.node.id, facts, listItems);
      const assignment = statement.type === "expression_statement" ? statement.namedChildren[0] : null;
      const right = assignment?.type === "assignment" ? assignment.childForFieldName("right") : null;
      const left = assignment?.childForFieldName("left");
      if (right?.type === "call" && left?.type === "identifier") facts.localCalls[`${fn.node.id}|${left.text}`] = compact(right.childForFieldName("function")?.text ?? "");
    }
    const params = parametersOf(fn, hasAnnotated);
    if (params.length > 0) facts.params[fn.node.id] = params;
  }

  if (facts.calls.length === 0 && facts.lists.length === 0 && Object.keys(facts.params).length === 0 && facts.middleware === undefined && facts.rootUrlconf === undefined
    && Object.keys(facts.classStrings).length === 0 && Object.keys(facts.aliases).length === 0) return;
  file.properties.pyFacts = JSON.stringify(facts);
};

// `name = [...]`, `name += [...]`, `name: T = [...]` as a URL list, and the Django settings.
function collectStatement(statement: SyntaxNode, scope: string | null, facts: PyFacts, items: (node: SyntaxNode, single?: boolean) => PyListItem[]): void {
  if (statement.type !== "expression_statement") return;
  const assignment = statement.namedChildren[0];
  if (!assignment || (assignment.type !== "assignment" && assignment.type !== "augmented_assignment")) return;
  const left = assignment.childForFieldName("left");
  const right = assignment.childForFieldName("right");
  if (!left || left.type !== "identifier" || !right) return;
  const name = left.text;

  if (scope === null && (name === "MIDDLEWARE" || name === "MIDDLEWARE_CLASSES" || name === "ROOT_URLCONF")) {
    if (name === "ROOT_URLCONF") {
      const value = stringOf(right);
      if (value) facts.rootUrlconf = value;
    } else if (right.type === "list" || right.type === "tuple") {
      facts.middleware = [...facts.middleware ?? [], ...right.namedChildren.flatMap((child) => stringOf(child) ?? [])];
    }
    return;
  }

  const found = items(right);
  if (found.length === 0 && !(name === "urlpatterns" || name === "routes")) return;
  if (found.length === 0 && right.type !== "list" && right.type !== "tuple") return;
  facts.lists.push({ scope, name, items: found, line: statement.startPosition.row + 1 });
}

function listItems(node: SyntaxNode, single = false): PyListItem[] {
  const line = node.startPosition.row + 1;
  switch (node.type) {
    case "list":
    case "tuple":
    case "parenthesized_expression":
      return node.namedChildren.flatMap((child) => child.type === "comment" ? [] : listItems(child, true));
    case "binary_operator":
      return [...listItems(node.childForFieldName("left")!), ...listItems(node.childForFieldName("right")!)];
    case "list_splat": {
      const inner = node.namedChildren[0];
      return inner ? [{ kind: "ref", expr: compact(inner.text), line }] : [];
    }
    case "identifier":
    case "attribute":
      return single || node.type === "attribute" || node.parent?.type === "binary_operator" ? [{ kind: "ref", expr: compact(node.text), line }] : [];
    case "call":
      return callItem(node);
    default:
      return [];
  }
}

function callItem(call: SyntaxNode): PyListItem[] {
  const callee = compact(call.childForFieldName("function")?.text ?? "").replace(/\s+/gu, "");
  const name = lastSegment(callee);
  const line = call.startPosition.row + 1;
  const { args, kwargs } = argumentsOf(call);
  const argumentNodes = call.childForFieldName("arguments")?.namedChildren.filter((arg) => arg.type !== "comment" && arg.type !== "keyword_argument") ?? [];
  const valueNode = (key: string, position: number): SyntaxNode | null =>
    call.childForFieldName("arguments")?.namedChildren.find((arg) => arg.type === "keyword_argument" && arg.childForFieldName("name")?.text === key)?.childForFieldName("value") ?? argumentNodes[position] ?? null;

  if (name === "format_suffix_patterns" && argumentNodes[0]) return listItems(argumentNodes[0]);
  if (!listCallees.has(name)) return [];
  const pattern = args[0] ?? kwargs.route ?? kwargs.path ?? null;

  if (name === "Mount") {
    const target = valueNode("routes", 1) ?? valueNode("app", 1);
    if (!target) return [];
    if (target.type === "list" || target.type === "tuple") return [{ kind: "include", callee, pattern, target: null, inline: listItems(target), line }];
    return [{ kind: "include", callee, pattern, target: compact(target.text), inline: null, line }];
  }

  if (name === "path" || name === "re_path" || name === "url") {
    const view = valueNode("view", 1);
    if (view?.type === "call" && lastSegment(view.childForFieldName("function")?.text ?? "") === "include") {
      const first = view.childForFieldName("arguments")?.namedChildren.find((arg) => arg.type !== "keyword_argument" && arg.type !== "comment");
      if (!first) return [];
      const unwrapped = first.type === "tuple" ? first.namedChildren[0] ?? first : first;
      if (unwrapped.type === "list") return [{ kind: "include", callee, pattern, target: null, inline: listItems(unwrapped), line }];
      return [{ kind: "include", callee, pattern, target: compact(unwrapped.text), inline: null, line }];
    }
    return [{ kind: "route", callee, pattern, view: view ? compact(view.text) : null, methods: null, line }];
  }

  // Route, WebSocketRoute, APIRoute, APIWebSocketRoute
  const endpoint = valueNode("endpoint", 1);
  return [{ kind: "route", callee, pattern, view: endpoint ? compact(endpoint.text) : null, methods: kwargs.methods ?? null, line }];
}

function argumentsOf(call: SyntaxNode): { args: string[]; kwargs: Record<string, string> } {
  const args: string[] = [];
  const kwargs: Record<string, string> = {};
  for (const arg of call.childForFieldName("arguments")?.namedChildren ?? []) {
    if (arg.type === "comment") continue;
    if (arg.type === "keyword_argument") {
      const key = arg.childForFieldName("name")?.text;
      const value = arg.childForFieldName("value");
      if (key && value) kwargs[key] = compact(value.text);
    } else {
      args.push(compact(arg.text));
    }
  }
  return { args, kwargs };
}

function stringOf(node: SyntaxNode): string | null {
  if (node.type !== "string") return null;
  if (node.namedChildren.some((part) => part.type === "interpolation")) return null;
  return node.namedChildren.filter((part) => part.type === "string_content").map((part) => part.text).join("");
}

// `CurrentUser = Annotated[User, Depends(current_user)]` (also `X: TypeAlias = ...`).
function collectAlias(statement: SyntaxNode, facts: PyFacts): void {
  if (statement.type !== "expression_statement") return;
  const assignment = statement.namedChildren[0];
  if (assignment?.type !== "assignment") return;
  const left = assignment.childForFieldName("left");
  const right = assignment.childForFieldName("right");
  if (left?.type !== "identifier" || right?.type !== "subscript" || !/^(?:typing\.)?Annotated$/u.test(right.childForFieldName("value")?.text ?? "")) return;
  const found = markerOf(right.descendantsOfType("call"), right.text);
  if (found) facts.aliases[left.text] = { name: left.text, ...found };
}

function collectClassStrings(definition: SyntaxNode, facts: PyFacts): void {
  const name = definition.childForFieldName("name")?.text;
  const body = definition.childForFieldName("body");
  if (!name || !body) return;
  const strings: Record<string, string> = {};
  for (const statement of body.namedChildren) {
    const assignment = statement.type === "expression_statement" ? statement.namedChildren[0] : null;
    if (assignment?.type !== "assignment") continue;
    const left = assignment.childForFieldName("left");
    const right = assignment.childForFieldName("right");
    const value = right ? stringOf(right) : null;
    if (left?.type === "identifier" && value !== null && (value.startsWith("/") || /^lookup_(?:url_kwarg|field)$/u.test(left.text))) strings[left.text] = value;
  }
  if (Object.keys(strings).length > 0) facts.classStrings[name] = strings;
}

function markerOf(calls: SyntaxNode[], typeText: string | undefined): Omit<PyParam, "name"> | null {
  for (const call of calls) {
    const marker = lastSegment(call.childForFieldName("function")?.text ?? "");
    if (!markers.has(marker)) continue;
    const { args, kwargs } = argumentsOf(call);
    const inner = /^Annotated\[\s*([^,\]]+(?:\[[^\]]*\])?)/u.exec(typeText ?? "")?.[1]?.trim();
    return { marker, arg: marker === "Depends" || marker === "Security" ? args[0] ?? kwargs.dependency ?? null : null, type: inner ?? (typeText ? compact(typeText) : null) };
  }
  return null;
}

// The FastAPI parameters of a function that carry `Depends(f)`, `Query(...)`…
// as default or `Annotated[T, Depends(f)]` metadata.
function parametersOf(fn: PythonParsedFunction, withAliases: boolean): PyParam[] {
  const list = fn.syntax.childForFieldName("parameters");
  if (!list) return [];
  const found: PyParam[] = [];
  for (const parameter of list.namedChildren) {
    const name = parameter.type === "identifier" ? parameter.text
      : parameter.type === "typed_parameter" ? parameter.namedChildren.find((child) => child.type === "identifier")?.text
        : parameter.childForFieldName("name")?.text;
    if (!name || name === "self" || name === "cls") continue;
    const type = parameter.childForFieldName("type");
    const value = parameter.childForFieldName("value");
    const candidates: SyntaxNode[] = [];
    if (value?.type === "call") candidates.push(value);
    if (type) candidates.push(...type.descendantsOfType("call"));
    const marked = markerOf(candidates, type?.text);
    if (marked) found.push({ name, ...marked });
    // `session: SessionDep`: a name that may be an alias of an Annotated type, looked up with the scan's names.
    else if (type && /^[A-Za-z_]\w*(?:\.\w+)*$/u.test(type.text) && withAliases) found.push({ name, marker: "alias", arg: type.text, type: null });
  }
  return found;
}

import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { PyListItem, PyParam } from "./facts.js";
import type { PythonContext } from "./context.js";

// Python HTTP routes. A route is a leaf of a container (a Flask app or
// blueprint, a FastAPI app or router, a Django `urlpatterns` list, a DRF
// router, a Starlette routes list, a Flask-RESTful Api); containers are
// mounted into each other (`register_blueprint`, `include_router`,
// `include("app.urls")`, `Mount`), and a leaf gets one Route per way a
// request can reach it, with the full path of that way.
//
//   Flask      @app.route / @app.get / add_url_rule, Blueprint(url_prefix),
//              register_blueprint(url_prefix) (replaces the blueprint's own),
//              before_request & co as lifecycle steps, MethodView classes
//   Flask-RESTful   Api(app).add_resource(Resource, "/x")
//   FastAPI    @app.get / @router.get / add_api_route, APIRouter(prefix),
//              include_router(prefix, dependencies), Depends (also nested)
//   Starlette  Route / WebSocketRoute / Mount lists, add_route, mount
//   Django     path / re_path / url / include (strings, modules, lists),
//              function views, `View.as_view()`, DRF @api_view, routers
//              (`register`, `@action`), MIDDLEWARE as lifecycle steps

type Kind = "flask-app" | "blueprint" | "fastapi-app" | "fastapi-router" | "starlette" | "drf-router" | "flask-restful" | "list";

type Step = { fnId: string; role: string; scope: string; hook: string | null; expression: string };

type Leaf = {
  fileId: string;
  scopeFn: string | null;
  framework: string;
  methods: string[];
  path: string | null;
  pathExpression: string | null;
  handlerId: string | null;
  handlerName: string | null;
  line: number;
  column: number;
  // FastAPI `dependencies=[Depends(..)]` of the route.
  dependencies: string[];
  extractors: string | null;
  // Steps of the handler beyond the container's (Depends of its signature).
  steps: Step[];
  layers: string[];
  // The route is declared by a DRF router registration (expanded later).
  viewset?: { prefix: string | null; viewsetId: string | null; expression: string };
};

type Mount = {
  // The file the mount is written in (its dependencies are names of that file).
  fileId: string;
  child: Entity;
  prefix: string | null;
  // The prefix as written, for the path expression of a route below a computed prefix.
  prefixExpression: string | null;
  explicit: boolean;
  dependencies: string[];
  framework: string;
};

type Entity = {
  key: string;
  fileId: string;
  scope: string | null;
  name: string;
  kind: Kind;
  line: number;
  prefix: string | null;
  prefixExpression: string | null;
  dependencies: string[];
  hooks: Step[];
  leaves: Leaf[];
  mounts: Mount[];
  items: PyListItem[];
  parents: Array<{ parent: Entity; mount: Mount }>;
  // Flask-RESTful Api(app): where its resources are served.
  target?: string | null;
  // DRF `DefaultRouter(trailing_slash=False)`.
  trailingSlash?: boolean;
};

// A parameter of a function; `fileId` is where its names are written when that is not the function's file (an alias).
type ResolvedParam = PyParam & { fileId?: string };

const MAX_DEPTH = 8;
const HTTP = new Set(["get", "post", "put", "delete", "patch", "head", "options", "trace"]);
const FLASK_HOOKS = new Set(["before_request", "after_request", "teardown_request", "before_app_request", "after_app_request", "teardown_app_request"]);
const CLASS_VIEW_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

// The HTTP methods a generic class-based view brings with its base class.
const GENERIC_VIEW_METHODS: Record<string, string[]> = {
  TemplateView: ["get"], DetailView: ["get"], ListView: ["get"], RedirectView: ["get"], ArchiveIndexView: ["get"],
  FormView: ["get", "post"], CreateView: ["get", "post"], UpdateView: ["get", "post"], DeleteView: ["get", "post", "delete"],
  ListAPIView: ["get"], CreateAPIView: ["post"], RetrieveAPIView: ["get"], DestroyAPIView: ["delete"], UpdateAPIView: ["put", "patch"],
  ListCreateAPIView: ["get", "post"], RetrieveUpdateAPIView: ["get", "put", "patch"], RetrieveDestroyAPIView: ["get", "delete"],
  RetrieveUpdateDestroyAPIView: ["get", "put", "patch", "delete"],
};
const DRF_ACTIONS: Record<string, string[]> = {
  ModelViewSet: ["list", "create", "retrieve", "update", "partial_update", "destroy"],
  ReadOnlyModelViewSet: ["list", "retrieve"],
  ListModelMixin: ["list"], CreateModelMixin: ["create"], RetrieveModelMixin: ["retrieve"],
  UpdateModelMixin: ["update", "partial_update"], DestroyModelMixin: ["destroy"],
};
const DRF_BASES = /^(?:APIView|GenericAPIView|ViewSet|GenericViewSet|ModelViewSet|ReadOnlyModelViewSet|\w+APIView|\w+ModelMixin)$/u;
const MIDDLEWARE_HOOKS = ["__call__", "process_request", "process_view", "process_template_response", "process_exception", "process_response"];

export function addPythonRoutes(context: PythonContext): { handlerIds: Set<string> } {
  const { graph, index } = context;
  const entities = new Map<string, Entity>();
  const entityKey = (fileId: string, scope: string | null, name: string) => `${fileId}|${scope ?? ""}|${name}`;
  const nodes: GraphNode[] = [];
  const relationships: GraphRelationship[] = [];

  // ---- containers ---------------------------------------------------------
  const constructors: Record<string, Kind> = {
    Flask: "flask-app", Quart: "flask-app", Blueprint: "blueprint", FastAPI: "fastapi-app", APIRouter: "fastapi-router",
    Starlette: "starlette", Router: "starlette", DefaultRouter: "drf-router", SimpleRouter: "drf-router", Api: "flask-restful",
  };
  const create = (fileId: string, scope: string | null, name: string, kind: Kind, line: number): Entity => {
    const entity: Entity = { key: entityKey(fileId, scope, name), fileId, scope, name, kind, line, prefix: null, prefixExpression: null, dependencies: [], hooks: [], leaves: [], mounts: [], items: [], parents: [] };
    entities.set(entity.key, entity);
    return entity;
  };

  for (const [fileId, calls] of context.callsByFile) {
    for (const call of calls) {
      const kind = constructors[call.callee.split(".").at(-1)!];
      if (!kind || !call.assigned) continue;
      const entity = create(fileId, call.scope, call.assigned, kind, call.line);
      const prefixExpression = kind === "blueprint" ? call.kwargs.url_prefix : kind === "fastapi-router" || kind === "flask-restful" ? call.kwargs.prefix : undefined;
      if (prefixExpression !== undefined) {
        entity.prefixExpression = prefixExpression;
        entity.prefix = context.literal(prefixExpression, fileId, call.scope);
      } else {
        entity.prefix = "";
      }
      if (kind === "fastapi-app" || kind === "fastapi-router") entity.dependencies = dependsOf(call.kwargs.dependencies);
      if (kind === "starlette" && call.kwargs.routes) entity.target = call.kwargs.routes;
      if (kind === "drf-router" && call.kwargs.trailing_slash === "False") entity.trailingSlash = false;
      if (kind === "flask-restful") entity.target = call.args[0] ?? call.kwargs.app ?? call.kwargs.blueprint ?? null;
    }
  }
  for (const [fileId, lists] of context.listsByFile) {
    for (const list of lists) {
      const key = entityKey(fileId, list.scope, list.name);
      const existing = entities.get(key);
      if (existing) {
        if (existing.kind === "list") existing.items.push(...list.items);
        continue;
      }
      const entity = create(fileId, list.scope, list.name, "list", list.line);
      entity.prefix = "";
      entity.items = [...list.items];
    }
  }

  const resolveEntity = (expression: string, fileId: string, scope: string | null): Entity | null => {
    const expr = expression.replace(/\s+/gu, "");
    const candidates = [expr];
    if (expr.endsWith(".urls")) candidates.push(expr.slice(0, -".urls".length));
    for (const candidate of candidates) {
      if (!candidate.includes(".")) {
        const local = entities.get(entityKey(fileId, scope, candidate)) ?? entities.get(entityKey(fileId, null, candidate));
        if (local) return local;
      }
      const variableId = index.lookupVariable(candidate, fileId) ?? index.lookupVariable(`${candidate}.urlpatterns`, fileId);
      if (variableId) {
        const variable = index.variablesById.get(variableId);
        const file = index.fileByVariableId.get(variableId);
        const found = variable && file ? entities.get(entityKey(file, null, String(variable.properties.name))) : undefined;
        if (found) return found;
      }
    }
    return null;
  };

  const entityOfModule = (source: string, fileId: string): Entity | null => {
    const relative = context.relativeOf.get(fileId);
    if (!relative) return null;
    const [target] = context.resolver.resolveImport({ importerFile: relative, source, importedName: null }).files;
    const targetId = target ? context.fileIds.get(target) : undefined;
    return targetId ? entities.get(entityKey(targetId, null, "urlpatterns")) ?? entities.get(entityKey(targetId, null, "routes")) ?? null : null;
  };

  // ---- handlers -----------------------------------------------------------
  const decoratorsOfHandler = (id: string) => context.decoratorsOf(id);
  const classOf = (expression: string, fileId: string): string | null => index.lookupType(expression, fileId);

  type Resolved = { functionId: string | null; classId: string | null; name: string };
  const resolveView = (expression: string, fileId: string): Resolved => {
    const asView = /^(.*?)\.as_view\(/u.exec(expression);
    const base = (asView ? asView[1]! : expression).replace(/\s+/gu, "");
    if (/^[\w.]+$/u.test(base)) {
      const classId = classOf(base, fileId);
      if (classId) return { functionId: null, classId, name: base };
      if (!asView) {
        const functionId = index.lookupFunction(base, fileId);
        if (functionId) return { functionId, classId: null, name: base };
      }
    }
    return { functionId: null, classId: null, name: asView ? base : expression };
  };

  const methodsOfClass = (classId: string): { methods: string[]; drf: boolean } => {
    const chain = context.classChain(classId);
    const methods = new Set(CLASS_VIEW_METHODS.filter((method) => chain.methods.has(method)));
    for (const base of chain.bases) for (const method of GENERIC_VIEW_METHODS[base] ?? []) methods.add(method);
    return { methods: CLASS_VIEW_METHODS.filter((method) => methods.has(method)), drf: [...chain.bases].some((base) => DRF_BASES.test(base)) };
  };

  const kwargOf = (decorator: { kwargs: Record<string, string> }, key: string) => decorator.kwargs[key];

  // Methods a function view allows: `@api_view([..])`, `@require_http_methods([..])`, `@require_GET`.
  const functionViewMethods = (functionId: string): { methods: string[] | null; drf: boolean } => {
    let drf = false;
    for (const decorator of decoratorsOfHandler(functionId)) {
      const name = decorator.name.split(".").at(-1)!;
      if (name === "api_view") {
        drf = true;
        return { methods: (context.literalList(decorator.positional[0] ?? kwargOf(decorator, "http_method_names")) ?? ["GET"]).map((method) => method.toUpperCase()), drf };
      }
      if (name === "require_http_methods") return { methods: (context.literalList(decorator.positional[0]) ?? []).map((method) => method.toUpperCase()), drf };
      if (name === "require_GET") return { methods: ["GET"], drf };
      if (name === "require_POST") return { methods: ["POST"], drf };
      if (name === "require_safe") return { methods: ["GET", "HEAD"], drf };
    }
    return { methods: null, drf };
  };

  // The FastAPI parameters of a function, with the aliases (`session: SessionDep`) expanded to what they stand for.
  const paramsOf = (functionId: string | null): ResolvedParam[] => {
    if (!functionId) return [];
    const fileId = context.fileOfFunction(functionId);
    if (!fileId) return [];
    const params: ResolvedParam[] = [];
    for (const param of context.factsByFile.get(fileId)?.params[functionId] ?? []) {
      if (param.marker !== "alias") {
        params.push(param);
        continue;
      }
      const variableId = index.lookupVariable(param.arg ?? "", fileId);
      const variable = variableId ? index.variablesById.get(variableId) : undefined;
      const aliasFile = variableId ? index.fileByVariableId.get(variableId) : undefined;
      const alias = variable && aliasFile ? context.factsByFile.get(aliasFile)?.aliases[String(variable.properties.name)] : undefined;
      // The alias's names are those of the file that defines it.
      if (alias && aliasFile) params.push({ ...alias, name: param.name, fileId: aliasFile });
    }
    return params;
  };

  const extractorsOf = (functionId: string | null): string | null => {
    const kinds = new Map([["Query", "query"], ["Path", "path"], ["Body", "json"], ["Header", "header"], ["Cookie", "cookies"], ["Form", "form"], ["File", "multipart"]]);
    const found = paramsOf(functionId).filter((param) => kinds.has(param.marker)).map((param) => ({ kind: kinds.get(param.marker)!, name: param.name, type: param.type }));
    return found.length > 0 ? JSON.stringify(found) : null;
  };

  // The functions a FastAPI `Depends` chain runs: dependencies first, nested ones before the one that needs them.
  const dependencySteps = (functionId: string | null, scope: string, seen: Set<string>, depth = 0): Step[] => {
    if (!functionId || depth > 4) return [];
    const fileId = context.fileOfFunction(functionId);
    if (!fileId) return [];
    const steps: Step[] = [];
    for (const param of paramsOf(functionId)) {
      if (param.marker !== "Depends" && param.marker !== "Security") continue;
      const target = dependencyTarget(param.arg ?? param.type, param.fileId ?? fileId);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      steps.push(...dependencySteps(target, scope, seen, depth + 1));
      steps.push({ fnId: target, role: "dependency", scope, hook: null, expression: `${param.marker}(${param.arg ?? param.type ?? ""})` });
    }
    return steps;
  };

  const dependencyTarget = (expression: string | null, fileId: string): string | null => {
    if (!expression) return null;
    const name = expression.replace(/\s+/gu, "").replace(/\(.*$/u, "");
    if (!/^[\w.]+$/u.test(name)) return null;
    const functionId = index.lookupFunction(name, fileId);
    if (functionId) return functionId;
    const classId = index.lookupType(name, fileId);
    return classId ? context.findMethod(classId, "__call__") ?? context.findMethod(classId, "__init__") : null;
  };

  const dependsSteps = (expressions: string[], fileId: string, scope: string, seen: Set<string>): Step[] => {
    const steps: Step[] = [];
    for (const expression of expressions) {
      const target = dependencyTarget(expression, fileId);
      if (!target || seen.has(target)) continue;
      seen.add(target);
      steps.push(...dependencySteps(target, scope, seen), { fnId: target, role: "dependency", scope, hook: null, expression: `Depends(${expression})` });
    }
    return steps;
  };

  // ---- leaves -------------------------------------------------------------
  const addLeaf = (entity: Entity, leaf: Omit<Leaf, "steps" | "layers" | "extractors" | "dependencies"> & Partial<Pick<Leaf, "steps" | "layers" | "extractors" | "dependencies">>) => {
    entity.leaves.push({ steps: [], layers: [], extractors: null, dependencies: [], ...leaf });
  };

  const fastApiLeaf = (entity: Entity, fileId: string, scopeFn: string | null, handlerId: string | null, handlerName: string, methods: string[], pathExpression: string | null, kwargs: Record<string, string>, line: number, column: number) => {
    const path = pathExpression === null ? "" : context.literal(pathExpression, fileId);
    const seen = new Set<string>();
    const routeDependencies = dependsOf(kwargs.dependencies);
    const steps = [
      ...dependsSteps(routeDependencies, fileId, "route", seen),
      ...dependencySteps(handlerId, "route", seen),
    ];
    for (const method of methods) {
      addLeaf(entity, {
        fileId, scopeFn, framework: "fastapi", methods: [method], path, pathExpression: path === null ? pathExpression : null, handlerId, handlerName,
        line, column, steps, extractors: extractorsOf(handlerId),
        layers: [...routeDependencies.map((dependency) => `Depends(${dependency})`), ...paramsOf(handlerId).filter((param) => param.marker === "Depends").map((param) => `Depends(${param.arg ?? param.type ?? ""})`)],
      });
    }
  };

  // Decorators: routes and hooks.
  for (const node of graph.nodes) {
    if (node.label !== "Function") continue;
    const decorators = decoratorsOfHandler(node.id);
    if (decorators.length === 0) continue;
    const fileId = context.fileOfFunction(node.id) ?? (node.id.split(":function:")[0] ?? "");
    const scope = context.factsByFile.get(fileId)?.nested[node.id] ?? null;
    for (const decorator of decorators) {
      const dot = decorator.name.lastIndexOf(".");
      if (dot < 0) continue;
      const method = decorator.name.slice(dot + 1);
      const entity = resolveEntity(decorator.name.slice(0, dot), fileId, scope);
      if (!entity) continue;
      const handlerName = String(node.properties.name);
      const pathExpression = decorator.positional[0] ?? decorator.kwargs.path ?? decorator.kwargs.rule ?? null;

      if (entity.kind === "flask-app" || entity.kind === "blueprint") {
        if (FLASK_HOOKS.has(method) || method === "teardown_appcontext") {
          if (method !== "teardown_appcontext") entity.hooks.push({ fnId: node.id, role: "middleware", scope: entity.kind === "blueprint" ? "blueprint" : "app", hook: method, expression: decorator.name });
          continue;
        }
        if (method !== "route" && !HTTP.has(method)) continue;
        const path = pathExpression === null ? null : context.literal(pathExpression, fileId);
        const methods = method === "route"
          ? (context.literalList(decorator.kwargs.methods) ?? (decorator.kwargs.methods ? ["ALL"] : ["GET"])).map((value) => value.toUpperCase())
          : [method.toUpperCase()];
        for (const value of methods) {
          addLeaf(entity, { fileId, scopeFn: scope, framework: "flask", methods: [value], path, pathExpression: path === null ? pathExpression : null, handlerId: node.id, handlerName, line: decorator.line, column: 0 });
        }
      } else if (entity.kind === "fastapi-app" || entity.kind === "fastapi-router") {
        if (method === "middleware") {
          entity.hooks.push({ fnId: node.id, role: "middleware", scope: "app", hook: "middleware", expression: decorator.name });
          continue;
        }
        if (!HTTP.has(method) && method !== "api_route" && method !== "websocket") continue;
        const methods = method === "websocket" ? ["WS"] : method === "api_route"
          ? (context.literalList(decorator.kwargs.methods) ?? ["GET"]).map((value) => value.toUpperCase())
          : [method.toUpperCase()];
        fastApiLeaf(entity, fileId, scope, node.id, handlerName, methods, pathExpression, decorator.kwargs, decorator.line, 0);
      } else if (entity.kind === "starlette") {
        if (method !== "route" && method !== "websocket_route") continue;
        const path = pathExpression === null ? null : context.literal(pathExpression, fileId);
        const methods = method === "websocket_route" ? ["WS"] : (context.literalList(decorator.kwargs.methods) ?? ["GET"]).map((value) => value.toUpperCase());
        for (const value of methods) {
          addLeaf(entity, { fileId, scopeFn: scope, framework: "starlette", methods: [value], path, pathExpression: path === null ? pathExpression : null, handlerId: node.id, handlerName, line: decorator.line, column: 0 });
        }
      }
    }
  }

  // Method calls on containers.
  const endpointLeaves = (entity: Entity, fileId: string, scope: string | null, framework: string, pathExpression: string | null, endpoint: string | null, methodsExpression: string | undefined, line: number, column: number, websocket = false, kwargs: Record<string, string> = {}) => {
    const path = pathExpression === null ? null : context.literal(pathExpression, fileId);
    const view = endpoint ? resolveView(endpoint, fileId) : { functionId: null, classId: null, name: "" };
    if (framework === "fastapi" && !view.classId) {
      const methods = websocket ? ["WS"] : (context.literalList(methodsExpression) ?? ["GET"]).map((value) => value.toUpperCase());
      fastApiLeaf(entity, fileId, scope, view.functionId, view.name, methods, pathExpression, kwargs, line, column);
      return;
    }
    let methods: Array<{ method: string; handlerId: string | null }>;
    if (view.classId) {
      const found = methodsOfClass(view.classId).methods;
      methods = (found.length > 0 ? found : ["ALL"]).map((method) => ({ method: method.toUpperCase(), handlerId: context.findMethod(view.classId!, method) }));
    } else if (websocket) {
      methods = [{ method: "WS", handlerId: view.functionId }];
    } else {
      methods = (context.literalList(methodsExpression) ?? (framework === "flask" && methodsExpression ? ["ALL"] : ["GET"])).map((method) => ({ method: method.toUpperCase(), handlerId: view.functionId }));
    }
    for (const { method, handlerId } of methods) {
      addLeaf(entity, { fileId, scopeFn: scope, framework, methods: [method], path, pathExpression: path === null ? pathExpression : null, handlerId, handlerName: view.name, line, column });
    }
  };

  for (const [fileId, calls] of context.callsByFile) {
    for (const call of calls) {
      const dot = call.callee.lastIndexOf(".");
      if (dot < 0) continue;
      const method = call.callee.slice(dot + 1);
      const receiver = resolveEntity(call.callee.slice(0, dot), fileId, call.scope);
      if (!receiver) continue;
      const prefixOf = (expression: string | undefined) => (expression === undefined ? "" : context.literal(expression, fileId, call.scope));
      const mountChild = (childExpression: string | undefined, prefixExpression: string | undefined, framework: string, explicit: boolean, dependencies: string[]) => {
        const child = childExpression ? resolveEntity(childExpression.replace(/^WSGIMiddleware\((.*)\)$/u, "$1"), fileId, call.scope) : null;
        if (!child || child === receiver) return;
        const mount: Mount = { fileId, child, prefix: prefixOf(prefixExpression), prefixExpression: prefixExpression ?? null, explicit, dependencies, framework };
        receiver.mounts.push(mount);
        child.parents.push({ parent: receiver, mount });
      };

      switch (method) {
        case "register_blueprint":
          mountChild(call.args[0], call.kwargs.url_prefix, "flask", call.kwargs.url_prefix !== undefined, []);
          break;
        case "include_router":
          mountChild(call.args[0] ?? call.kwargs.router, call.kwargs.prefix, "fastapi", true, dependsOf(call.kwargs.dependencies));
          break;
        case "mount":
          mountChild(call.args[1] ?? call.kwargs.app, call.args[0] ?? call.kwargs.path, receiver.kind === "starlette" ? "starlette" : "fastapi", true, []);
          break;
        case "add_url_rule": {
          if (receiver.kind !== "flask-app" && receiver.kind !== "blueprint") break;
          const endpoint = call.kwargs.view_func ?? call.args[2] ?? null;
          endpointLeaves(receiver, fileId, call.scope, "flask", call.args[0] ?? call.kwargs.rule ?? null, endpoint, call.kwargs.methods, call.line, call.column);
          break;
        }
        case "add_api_route":
        case "add_api_websocket_route":
          if (receiver.kind === "fastapi-app" || receiver.kind === "fastapi-router") {
            endpointLeaves(receiver, fileId, call.scope, "fastapi", call.args[0] ?? call.kwargs.path ?? null, call.args[1] ?? call.kwargs.endpoint ?? null, call.kwargs.methods, call.line, call.column, method === "add_api_websocket_route", call.kwargs);
          }
          break;
        case "add_route":
        case "add_websocket_route":
          if (receiver.kind === "starlette" || receiver.kind === "fastapi-app") {
            endpointLeaves(receiver, fileId, call.scope, receiver.kind === "starlette" ? "starlette" : "fastapi", call.args[0] ?? call.kwargs.path ?? null, call.args[1] ?? call.kwargs.route ?? null, call.kwargs.methods, call.line, call.column, method === "add_websocket_route", call.kwargs);
          }
          break;
        case "register":
          if (receiver.kind === "drf-router" && call.args.length >= 2) {
            const prefix = context.literal(call.args[0], fileId);
            const viewset = resolveView(call.args[1]!, fileId);
            addLeaf(receiver, {
              fileId, scopeFn: call.scope, framework: "django-rest-framework", methods: [], path: prefix, pathExpression: prefix === null ? call.args[0]! : null,
              handlerId: null, handlerName: viewset.name, line: call.line, column: call.column,
              viewset: { prefix, viewsetId: viewset.classId, expression: viewset.name },
            });
          }
          break;
        case "add_resource":
          if (receiver.kind === "flask-restful") {
            const resource = resolveView(call.args[0] ?? "", fileId);
            for (const urlExpression of call.args.slice(1)) {
              const path = context.literal(urlExpression, fileId);
              const methods = resource.classId ? methodsOfClass(resource.classId).methods : [];
              for (const value of methods.length > 0 ? methods : ["all"]) {
                addLeaf(receiver, {
                  fileId, scopeFn: call.scope, framework: "flask-restful", methods: [value.toUpperCase()], path, pathExpression: path === null ? urlExpression : null,
                  handlerId: resource.classId ? context.findMethod(resource.classId, value) : null, handlerName: resource.name, line: call.line, column: call.column,
                });
              }
            }
          }
          break;
        default:
          break;
      }
    }
  }

  // Constructors that carry their own mounts: `Api(app)`, `Starlette(routes=routes)`.
  for (const entity of entities.values()) {
    if (entity.kind === "flask-restful" && entity.target) {
      const parent = resolveEntity(entity.target, entity.fileId, entity.scope);
      if (parent && parent !== entity) {
        const mount: Mount = { fileId: entity.fileId, child: entity, prefix: "", prefixExpression: null, explicit: false, dependencies: [], framework: "flask-restful" };
        parent.mounts.push(mount);
        entity.parents.push({ parent, mount });
      }
    } else if (entity.kind === "starlette" && entity.target) {
      const list = resolveEntity(entity.target, entity.fileId, entity.scope);
      if (list && list !== entity) {
        const mount: Mount = { fileId: entity.fileId, child: list, prefix: "", prefixExpression: null, explicit: true, dependencies: [], framework: "starlette" };
        entity.mounts.push(mount);
        list.parents.push({ parent: entity, mount });
      }
    }
  }

  // URL lists: the items of `urlpatterns` and Starlette routes.
  let inlineCount = 0;
  const readItems = (entity: Entity, items: PyListItem[], depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const item of items) {
      const fileId = entity.fileId;
      if (item.kind === "route") {
        const framework = item.callee.endsWith("path") || item.callee.endsWith("url") ? "django" : "starlette";
        const regex = item.callee.endsWith("re_path") || item.callee.endsWith("url");
        const pattern = item.pattern === null ? null : context.literal(item.pattern, fileId);
        const path = pattern === null ? null : framework === "django" && regex ? cleanRegexPath(pattern) : pattern;
        if (!item.view || /\.site\.urls$/u.test(item.view)) continue;
        const websocket = /WebSocketRoute$/u.test(item.callee) || item.callee.endsWith("APIWebSocketRoute");
        const extra = { pathExpression: path === null ? item.pattern : null };
        const view = resolveView(item.view, fileId);
        if (framework === "django") {
          if (view.classId) {
            const { methods, drf } = methodsOfClass(view.classId);
            for (const method of methods.length > 0 ? methods : ["all"]) {
              addLeaf(entity, { fileId, scopeFn: null, framework: drf ? "django-rest-framework" : "django", methods: [method.toUpperCase()], path, ...extra, handlerId: context.findMethod(view.classId, method), handlerName: view.name, line: item.line, column: 0 });
            }
          } else if (view.functionId) {
            const { methods, drf } = functionViewMethods(view.functionId);
            for (const method of methods ?? ["ALL"]) {
              addLeaf(entity, { fileId, scopeFn: null, framework: drf ? "django-rest-framework" : "django", methods: [method], path, ...extra, handlerId: view.functionId, handlerName: view.name, line: item.line, column: 0 });
            }
          } else {
            addLeaf(entity, { fileId, scopeFn: null, framework: "django", methods: ["ALL"], path, ...extra, handlerId: null, handlerName: item.view.replace(/\(.*$/u, ""), line: item.line, column: 0 });
          }
        } else {
          endpointLeaves(entity, fileId, null, "starlette", item.pattern, item.view, item.methods ?? undefined, item.line, 0, websocket);
        }
        continue;
      }
      if (item.kind === "include") {
        let child: Entity | null = null;
        if (item.inline) {
          child = create(fileId, entity.scope, `<inline:${item.line}:${inlineCount += 1}>`, "list", item.line);
          child.prefix = "";
          child.items = item.inline;
          readItems(child, item.inline, depth + 1);
        } else if (item.target) {
          const literal = context.literal(item.target, fileId);
          child = literal !== null && /^[\w.]+$/u.test(literal) && !/^[A-Za-z_]\w*$/u.test(item.target) ? entityOfModule(literal, fileId) : null;
          child ??= /^["']/u.test(item.target) ? entityOfModule(literal ?? "", fileId) : resolveEntity(item.target, fileId, entity.scope);
        }
        if (child && child !== entity) {
          const regex = item.callee.endsWith("re_path") || item.callee.endsWith("url");
          const pattern = item.pattern === null ? null : context.literal(item.pattern, fileId);
          const mount: Mount = { fileId, child, prefixExpression: item.pattern, prefix: pattern === null ? null : item.callee.endsWith("Mount") ? pattern : regex ? cleanRegexPath(pattern) : pattern, explicit: true, dependencies: [], framework: item.callee.endsWith("Mount") ? "starlette" : "django" };
          entity.mounts.push(mount);
          child.parents.push({ parent: entity, mount });
        }
        continue;
      }
      const target = resolveEntity(item.expr, fileId, entity.scope);
      if (target && target !== entity) {
        const mount: Mount = { fileId, child: target, prefix: "", prefixExpression: null, explicit: true, dependencies: [], framework: "django" };
        entity.mounts.push(mount);
        target.parents.push({ parent: entity, mount });
      }
    }
  };
  for (const entity of [...entities.values()]) {
    if (entity.kind === "list" && entity.items.length > 0 && !entity.name.startsWith("<inline")) readItems(entity, entity.items, 0);
  }

  // DRF routers expand their registrations into standard actions and `@action`s.
  for (const entity of entities.values()) {
    if (entity.kind !== "drf-router") continue;
    const registrations = entity.leaves.filter((leaf) => leaf.viewset);
    entity.leaves = entity.leaves.filter((leaf) => !leaf.viewset);
    for (const registration of registrations) {
      const { prefix, viewsetId, expression } = registration.viewset!;
      if (prefix === null) continue;
      const base = prefix.replace(/^\/+|\/+$/gu, "");
      const slash = entity.trailingSlash === false ? "" : "/";
      const listPath = base === "" ? "" : `${base}${slash}`;
      const lookup = viewsetId ? context.classString(viewsetId, "lookup_url_kwarg") ?? context.classString(viewsetId, "lookup_field") ?? "pk" : "pk";
      const listBase = base === "" ? "" : `${base}/`;
      const detailBase = `${listBase}<${lookup}>/`;
      const detailPath = `${listBase}<${lookup}>${slash}`;
      const standard: Array<[string, string, string]> = [
        ["list", "GET", listPath], ["create", "POST", listPath],
        ["retrieve", "GET", detailPath], ["update", "PUT", detailPath], ["partial_update", "PATCH", detailPath], ["destroy", "DELETE", detailPath],
      ];
      const chain = viewsetId ? context.classChain(viewsetId) : null;
      const actions = new Set<string>(chain ? [...chain.methods] : []);
      for (const baseName of chain?.bases ?? []) for (const action of DRF_ACTIONS[baseName] ?? []) actions.add(action);
      for (const [action, method, path] of standard) {
        if (!actions.has(action)) continue;
        addLeaf(entity, {
          ...registration, viewset: undefined, methods: [method], path, pathExpression: null,
          handlerId: viewsetId ? context.findMethod(viewsetId, action) : null, handlerName: `${expression}.${action}`,
        });
      }
      for (const id of chain?.ids ?? []) {
        for (const [, functionIds] of index.methods.get(id) ?? []) {
          for (const functionId of functionIds) {
            const action = decoratorsOfHandler(functionId).find((decorator) => decorator.name.split(".").at(-1) === "action");
            if (!action) continue;
            const name = String(context.nodeById.get(functionId)?.properties.name);
            const detail = action.kwargs.detail === "True" || action.kwargs.detail === "true";
            const urlPath = context.literal(action.kwargs.url_path, registration.fileId) ?? name;
            const methods = (context.literalList(action.kwargs.methods) ?? ["get"]).map((method) => method.toUpperCase());
            for (const method of methods) {
              addLeaf(entity, {
                ...registration, viewset: undefined, methods: [method], path: `${detail ? detailBase : listBase}${urlPath}${slash}`, pathExpression: null,
                handlerId: functionId, handlerName: `${expression}.${name}`,
              });
            }
          }
        }
      }
    }
  }

  // ---- paths and layers ---------------------------------------------------
  type Dependencies = { expressions: string[]; fileId: string };
  type Chain = { segments: string[]; layers: Step[][]; dependencies: Dependencies[]; style: "django" | "slash" };
  // A prefix that is computed (`settings.api_prefix`) stays in the path as a marked placeholder.
  const dynamicMark = "\u0000";
  const segment = (value: string | null, expression: string | null): string => value ?? `${dynamicMark}\${${expression ?? "?"}}`;
  const ownSegments = (entity: Entity, mount: Mount | null): string[] => {
    if (entity.kind === "blueprint") return [mount?.explicit ? segment(mount.prefix, mount.prefixExpression) : segment(entity.prefix, entity.prefixExpression)];
    if (entity.kind === "list" || entity.kind === "drf-router") return [mount ? segment(mount.prefix, mount.prefixExpression) : ""];
    if (entity.kind === "fastapi-router" || entity.kind === "flask-restful") return mount ? [segment(mount.prefix, mount.prefixExpression), segment(entity.prefix, entity.prefixExpression)] : [segment(entity.prefix, entity.prefixExpression)];
    return [mount ? segment(mount.prefix, mount.prefixExpression) : ""];
  };

  const chainsOf = (entity: Entity, depth: number, seen: Set<string>): Chain[] => {
    const style = entity.kind === "list" || entity.kind === "drf-router" ? "django" : "slash";
    if (entity.parents.length === 0 || depth > MAX_DEPTH || seen.has(entity.key)) {
      return [{ segments: ownSegments(entity, null), layers: [entity.hooks], dependencies: [{ expressions: entity.dependencies, fileId: entity.fileId }], style }];
    }
    const chains: Chain[] = [];
    for (const { parent, mount } of entity.parents) {
      for (const outer of chainsOf(parent, depth + 1, new Set([...seen, entity.key]))) {
        chains.push({
          segments: [...outer.segments, ...ownSegments(entity, mount)],
          layers: [...outer.layers, entity.hooks],
          dependencies: [...outer.dependencies, { expressions: mount.dependencies, fileId: mount.fileId }, { expressions: entity.dependencies, fileId: entity.fileId }],
          style: outer.style === "django" || style === "django" ? "django" : "slash",
        });
      }
    }
    return chains;
  };

  const settings = [...context.factsByFile.entries()].filter(([, facts]) => facts.middleware !== undefined);
  const djangoMiddleware = chooseMiddleware(settings, context);
  const middlewareSteps = djangoMiddleware ? resolveMiddleware(djangoMiddleware.names, context) : [];

  const handlerIds = new Set<string>();
  const usedIds = new Set<string>();
  for (const entity of entities.values()) {
    if (entity.leaves.length === 0) continue;
    const chains = dedupe(chainsOf(entity, 0, new Set()));
    for (const leaf of entity.leaves) {
      chains.forEach((chain, position) => {
        const dynamicMount = chain.segments.some((part) => part.startsWith(dynamicMark));
        const dynamic = dynamicMount || leaf.path === null;
        const joined = dynamic ? null : joinPaths([...chain.segments, leaf.path!], chain.style);
        const pathExpression = dynamicMount ? joinPaths([...chain.segments.map((part) => part.replace(dynamicMark, "")), leaf.path ?? `\${${leaf.pathExpression}}`], chain.style) : null;
        const method = leaf.methods[0] ?? "ALL";
        let id = `${leaf.fileId}:route:${leaf.line}:${leaf.column}:${method}:${leaf.path ?? leaf.pathExpression}${position > 0 ? `@${position}` : ""}`;
        for (let n = 1; usedIds.has(id); n += 1) id = `${id.replace(/#\d+$/u, "")}#${n}`;
        usedIds.add(id);

        const layerSteps: Step[] = [];
        if (leaf.framework === "django" || leaf.framework === "django-rest-framework") layerSteps.push(...middlewareSteps);
        const seen = new Set<string>();
        // The root's hooks and dependencies run first, then each mounted container's.
        for (const hooks of chain.layers) layerSteps.push(...hooks);
        chain.dependencies.forEach((dependencies, depth) => {
          layerSteps.push(...dependsSteps(dependencies.expressions, dependencies.fileId, depth === 0 ? "app" : "router", seen));
        });
        for (const step of leaf.steps) if (!seen.has(step.fnId)) layerSteps.push(step);
        const steps = layerSteps.filter((step, at) => layerSteps.findIndex((other) => other.fnId === step.fnId && other.role === step.role) === at);
        const layerNames = [
          ...(leaf.framework === "django" || leaf.framework === "django-rest-framework" ? djangoMiddleware?.names ?? [] : []),
          ...chain.layers.flat().map((step) => step.expression),
          ...chain.dependencies.flatMap((dependencies) => dependencies.expressions).map((expression) => `Depends(${expression})`),
          ...leaf.layers,
        ];

        const node: GraphNode = {
          id,
          label: "Route",
          properties: {
            method,
            path: leaf.path,
            fullPath: joined,
            pathExpression: leaf.path === null ? leaf.pathExpression : pathExpression,
            receiverName: entity.name.startsWith("<") ? null : entity.name,
            line: leaf.line,
            framework: leaf.framework,
            handlerName: leaf.handlerName,
            pendingHandlerRefs: null,
            scopeFunctionId: leaf.scopeFn,
            layers: layerNames.length > 0 ? JSON.stringify([...new Set(layerNames)]) : null,
            extractors: leaf.extractors,
          },
        };
        nodes.push(node);
        relationships.push({ from: leaf.fileId, to: id, type: "DECLARES_ROUTE", properties: {} });
        if (leaf.handlerId) {
          relationships.push({ from: id, to: leaf.handlerId, type: "ROUTE_HANDLED_BY", properties: {} });
          handlerIds.add(leaf.handlerId);
        }
        const ordered: Array<Step | { fnId: string; role: "handler"; scope: string; hook: string; expression: string }> = [...steps.filter((step) => step.fnId !== leaf.handlerId)];
        if (leaf.handlerId) ordered.push({ fnId: leaf.handlerId, role: "handler", scope: "route", hook: "handler", expression: "" });
        ordered.forEach((step, orderIndex) => {
          relationships.push({
            from: id, to: step.fnId, type: "ROUTE_LIFECYCLE_STEP",
            properties: { role: step.role, scope: step.scope, hook: step.hook, orderIndex, ...step.expression ? { expression: step.expression } : {} },
          });
        });
        for (let orderIndex = 0; orderIndex < ordered.length - 1; orderIndex += 1) {
          relationships.push({ from: ordered[orderIndex]!.fnId, to: ordered[orderIndex + 1]!.fnId, type: "LIFECYCLE_PRECEDES", properties: { routeId: id, scope: "route", orderIndex } });
        }
      });
    }
  }

  graph.addNodes(nodes);
  graph.addRelationships(relationships);
  return { handlerIds };
}

function dedupe<T extends { segments: string[]; layers: Array<Array<{ fnId: string }>> }>(chains: T[]): T[] {
  return [...new Map(chains.map((chain) => [`${chain.segments.join("\0")}|${chain.layers.flat().map((step) => step.fnId).join(",")}`, chain])).values()];
}

// `Depends(a), Depends(b)` of `dependencies=[...]`: the callables.
function dependsOf(expression: string | undefined): string[] {
  if (!expression) return [];
  return [...expression.matchAll(/\b(?:Depends|Security)\(\s*([\w.]+)/gu)].map((match) => match[1]!);
}

export function joinPaths(parts: string[], style: "django" | "slash"): string {
  if (style === "django") {
    const joined = parts.join("");
    return joined.startsWith("/") ? joined : `/${joined}`;
  }
  let path = "";
  const slashed = (part: string) => part.startsWith("/") || part.startsWith("${");
  for (const part of parts) {
    if (part === "") continue;
    if (path === "") path = slashed(part) ? part : `/${part}`;
    else path = path.replace(/\/$/u, "") + (slashed(part) ? part : `/${part}`);
  }
  return path === "" ? "/" : path;
}

// A `re_path` regex as a path: `^articles/(?P<year>[0-9]{4})/$` is `articles/<year>/`.
export function cleanRegexPath(source: string): string {
  // `/?$` makes the trailing slash optional: the path is written without it.
  const pattern = source.replace(/\/\?(?=\$?$)/u, "");
  let result = "";
  for (let at = 0; at < pattern.length; at += 1) {
    const char = pattern[at]!;
    if (char === "\\" && at + 1 < pattern.length) {
      const next = pattern[at + 1]!;
      result += /[/.\-_]/u.test(next) ? next : `\\${next}`;
      at += 1;
    } else if (char === "(") {
      let depth = 1;
      let end = at + 1;
      for (; end < pattern.length && depth > 0; end += 1) {
        if (pattern[end] === "\\") end += 1;
        else if (pattern[end] === "(") depth += 1;
        else if (pattern[end] === ")") depth -= 1;
      }
      const group = pattern.slice(at + 1, end - 1);
      const named = /^\?P<(\w+)>/u.exec(group);
      result += named ? `<${named[1]}>` : group.startsWith("?:") ? `(${group})` : "<arg>";
      at = end - 1;
    } else if (char === "^" && at === 0) {
      continue;
    } else if (char === "$" && at === pattern.length - 1) {
      continue;
    } else {
      result += char;
    }
  }
  return result;
}

function chooseMiddleware(settings: Array<[string, { middleware?: string[] }]>, context: PythonContext): { names: string[] } | null {
  if (settings.length === 0) return null;
  const score = (fileId: string) => {
    const file = context.relativeOf.get(fileId) ?? "";
    return /(^|\/)settings\.py$|(^|\/)settings\/(?:base|common|settings)\.py$/u.test(file) ? 0 : /settings/u.test(file) ? 1 : 2;
  };
  const [, best] = [...settings].sort((a, b) => score(a[0]) - score(b[0]) || (context.relativeOf.get(a[0]) ?? "").localeCompare(context.relativeOf.get(b[0]) ?? "", "en"))[0]!;
  return { names: best.middleware ?? [] };
}

// `"app.middleware.Audit"` is the class `Audit` of the module `app.middleware` (or a function of it): the step runs its `__call__`, else the first `process_*` hook it defines.
function resolveMiddleware(names: string[], context: PythonContext): Step[] {
  const steps: Step[] = [];
  const { index } = context;
  for (const name of names) {
    const dot = name.lastIndexOf(".");
    if (dot < 0) continue;
    const [module, member] = [name.slice(0, dot), name.slice(dot + 1)];
    const importer = [...context.fileIds.keys()].find((file) => file.endsWith(".py")) ?? "";
    const [target] = context.resolver.resolveImport({ importerFile: importer, source: module, importedName: null }).files;
    const fileId = target ? context.fileIds.get(target) : undefined;
    if (!fileId) continue;
    const classId = index.classByFileAndName.get(fileId)?.get(member);
    if (classId) {
      const hook = MIDDLEWARE_HOOKS.find((candidate) => context.findMethod(classId, candidate));
      const fnId = hook ? context.findMethod(classId, hook) : null;
      if (fnId) steps.push({ fnId, role: "middleware", scope: "app", hook: hook!, expression: name });
      continue;
    }
    const fnId = index.lookupFunction(member, fileId);
    if (fnId) steps.push({ fnId, role: "middleware", scope: "app", hook: null, expression: name });
  }
  return steps;
}


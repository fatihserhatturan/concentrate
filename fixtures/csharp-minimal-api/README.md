# csharp-minimal-api

Minimal APIs (`framework: aspnet-minimal`). Expected `list_routes` facts:

| Route | Handler | Why |
| --- | --- | --- |
| `GET /`, `GET /health` | lambda in `<top-level>` | `handlerName: "<lambda>"`, linked to the enclosing Function |
| `GET /api/v1/todos` | lambda | `api = app.MapGroup("/api")`, `v1 = api.MapGroup("/v1").RequireAuthorization()` (nested groups in locals) |
| `GET /api/v1/todos/{id:int}`, `POST /api/v1/todos` | `TodoHandlers.GetTodo`, `CreateTodo` | method groups linked to the Function |
| `PUT /api/v1/todos/{id:int}` | lambda | `handlerParameters` keeps `[FromServices] ITodoService todos, int id, Todo todo` |
| `DELETE /api/v1/todos/{id:int}` | `DeleteTodo` | local (static) function of the top-level code: linked to `<top-level>`, `handlerName: DeleteTodo` |
| `POST` and `PUT /api/todos/{id:int}/archive` | `TodoHandlers.Archive` | `MapMethods(path, new[] {..}, handler)` |
| `GET` and `HEAD /api/ping` | lambda | `MapMethods` with a collection expression |
| `ALL /api/any` | lambda | `Map(path, handler)` |
| `GET /admin/stats` | lambda | chained `app.MapGroup("/admin").MapGet(...)` |
| `GET /reports`, `/reports/open`, `POST /reports/daily` | `ReportEndpoints.MapTodoReports` | extension method on `IEndpointRouteBuilder`; nested group `RouteGroupBuilder nested = reports.MapGroup("/daily")`; the prefix the caller adds is unknown (relative paths) |
| `GET /legacy` | lambda in `LegacyStartup.Configure` | `endpoints` parameter of `UseEndpoints` |
| `GET` with `path: null`, `pathExpression` `Routes.Export` | `TodoHandlers.Export` | constant path: never guessed |
| `GET` with `path: null`, `pathExpression` `$"/{Routes.Version}/info"` | lambda | interpolated path |

Not routes: `app.Map("/branch", branch => ...)` (the middleware branch of `IApplicationBuilder`).

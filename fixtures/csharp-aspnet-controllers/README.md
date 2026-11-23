# csharp-aspnet-controllers

ASP.NET Core MVC controllers (`framework: aspnet-mvc`). Expected `list_routes` facts:

| Route | Handler | Why |
| --- | --- | --- |
| `GET /api/v1/Products/ping` | `ApiControllerBase.Ping` | action inherited from the abstract user base controller; `[controller]` is the concrete name; the base class `[Route]` is inherited |
| `GET /api/v1/Products/version` | `ProductsController.Version` | the override wins over `ApiControllerBase.Version` |
| `GET /api/v1/Products` | `List` | verb attribute without template |
| `GET /api/v1/Products/{id:int}` | `Get` | constraint kept verbatim |
| `POST /api/v1/Products` | `Create` | |
| `PUT` and `PATCH /api/v1/Products/{id:int}` | `Update` | one Route per verb attribute |
| `DELETE /api/legacy/products/{id}` | `Remove` | `/` template ignores the class prefix |
| `GET /health/products` | `Health` | `~/` template ignores the class prefix |
| `GET /api/v1/Products/search/{**query}` | `SearchAsync` | |
| `GET` and `HEAD /api/v1/Products/exists/{id}` | `Exists` | `[AcceptVerbs]` with `Route =` |
| `ALL /api/v1/Products/export` | `Export` | `[Route]` without a verb |
| `GET /api/orders/{id}` and `GET /api/v2/orders/{id}` | `OrdersController.Get` | two class `[Route]`s: one Route per path (primary-constructor controller) |
| `POST .../{id}/ship`, `GET .../all`, `ALL /api/orders` and `/api/v2/orders` | `Ship`, `ListAll` (`[ActionName("all")]` + `[action]`), `Anything` | an action with no verb answers every method at the class route |
| `DELETE` with `path: null`, `pathExpression` `"api/orders" + Routes.OrderById` | `Cancel` | constant template: never guessed |
| `ALL /Home/Index`, `ALL /Home/About`, `POST /Home/Contact` | `HomeController` | no `[ApiController]`: conventional `/<controller>/<action>` |
| `ALL /terms` | `HomeController.Terms` | `[Route]` on an MVC action |
| `GET /Admin/Users/Index`, `POST /admin/users/reset` | `Admin.UsersController` | `[area]`, `[controller]`, `[action]` tokens |

Never routes: `[NonAction]` (`Helper`, `Format`), `static` and non-public methods, `OnActionExecuting` (a framework
override), `UserService` and `AuditJob` (not controllers: no `ControllerBase`, `[ApiController]` or `[Controller]`), the
abstract `ApiControllerBase` itself.

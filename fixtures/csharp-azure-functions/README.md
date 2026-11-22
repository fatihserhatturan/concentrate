# csharp-azure-functions

Phase 46 fixture: an isolated worker project (`Isolated/`, `[Function]`, `host.json` with `routePrefix: "svc"`) and an
in-process project (`InProcess/`, `[FunctionName]`, `host.json` without a prefix, so `api`).

Expected EntryPoints (`kind: function`, `library: azure-functions`):

| Handler | Trigger | `resolved` |
| --- | --- | --- |
| `ItemFunctions.GetItem` | `http` | true |
| `ItemFunctions.SaveItem` | `http` | true |
| `ItemFunctions.Ping` | `http` | true |
| `ItemFunctions.Health` | `http` | true |
| `BackgroundFunctions.Cleanup` | `timer:0 */5 * * * *` | true |
| `BackgroundFunctions.NightlyReport` | `timer:%ReportSchedule%` | false |
| `BackgroundFunctions.ProcessOrder` | `queue:orders` | true |
| `BackgroundFunctions.ProcessRefund` | `queue:QueueNames.Refunds` | false |
| `BackgroundFunctions.OnUpload` | `blob:uploads/{name}` | true |
| `BackgroundFunctions.OnAlert` | `servicebus:alerts/billing` | true |
| `BackgroundFunctions.OnTelemetry` | `eventhub:telemetry` | true |
| `BackgroundFunctions.OnItemChange` | `cosmosdb:shop/items` | true |
| `LegacyFunctions.Run` | `http` | true |
| `LegacyFunctions.Tick` | `timer:0 0 * * * *` | true |
| `LegacyFunctions.Dequeue` | `queue:legacy-orders` | true |

`ItemFunctions.NotAFunction` has a `QueueTrigger` but no `[Function]`: no entrypoint.

Expected Routes (framework `azure-functions`, handled by the function):

| Method | Path |
| --- | --- |
| GET | `/svc/items/{id:int}` |
| POST, PUT | `/svc/items` |
| ALL | `/svc/Ping` (no verbs, the function name is the path) |
| GET | none: `pathExpression` `Routes.Health` (a constant is never guessed) |
| GET, POST | `/api/legacy/{id}` (no prefix in that `host.json`) |

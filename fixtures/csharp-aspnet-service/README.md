# csharp-aspnet-service

Phase 46 acceptance fixture: one ASP.NET Core 8 service (Inventory.Service) that combines controllers, minimal APIs
with `MapGroup`, a gRPC service and client, a SignalR hub, a `BackgroundService`, an `IHostedService` and DI
registrations with single and ambiguous implementations.

Expected facts (asserted by `tests/csharp-aspnet-service.test.ts`):

- Routes (`list_routes`):
  - `aspnet-mvc`: `GET /api/Stock/{sku}`, `POST /api/Stock/{sku}/reserve`, `POST /api/alerts`.
  - `aspnet-minimal`: `GET /minimal/v1/stock/{sku}` (method group `StockHandlers.Peek`), `POST /minimal/v1/stock/{sku}/reserve`
    (lambda), `POST /minimal/v1/alerts` (method group `StockHandlers.Notify`), `GET /health` (lambda).
- EntryPoints: grpc `Stocker/Reserve`, `Stocker/Check`; signalr `StockHub/Watch` with `hubPath` `/realtime/stock`
  (the `MapGroup` prefix is applied); hosted-service `ReplenishWorker` (`ExecuteAsync`) and `AuditFlusher` (`StartAsync`).
- DI: `IStockRepository` -> `SqlStockRepository`, `IStockService` -> `StockService`, `IClock` -> `SystemClock` resolve.
  `INotifier` has two implementations (`EmailNotifier`, `SmsNotifier`): no edge, `ambiguousInjections` is counted on
  `AlertsController` (primary constructor), `AuditFlusher` and, for the `StockHandlers.Notify` handler parameter, on `StockHandlers`.
- Handler-parameter injection (`via: "handler-parameter"`, `INJECTS` Class -> Class): `StockHandlers -> StockService`
  for `Peek` (`IStockService service`; `string sku` and `CancellationToken` are not services). The lambdas in `Program.cs`
  are top-level statements with no declaring class, so no edge is emitted for them (their calls still resolve through
  the call graph).
- gRPC client: `StockProbe.IsKnown` calls `Stocker.StockerClient.Check`, which resolves to `StockGrpcService.Check`.
- `impact_of` `SqlStockRepository.Save` reaches the controller route `POST /api/Stock/{sku}/reserve`, the minimal route
  `POST /minimal/v1/stock/{sku}/reserve` (and `GET /health`: lambda handlers link to the enclosing `<top-level>` function),
  the hosted services and the gRPC `Reserve` entrypoint through the injected interfaces.

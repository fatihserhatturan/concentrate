# csharp-dotnet-data-service

Phase 47 acceptance fixture: one ASP.NET Core 8 service (Fulfilment.Service) with controllers and minimal endpoints,
an EF Core `DbContext`, a Dapper repository, `appsettings.json` / `appsettings.Production.json`, `IOptions<T>`,
`Environment.GetEnvironmentVariable`, a typed `HttpClient` and a Refit client, all wired through DI.

Expected facts (asserted by `tests/csharp-dotnet-data-service.test.ts`):

- Tables (`list_tables`): `orders` (`[Table]`, `Order`, efcore), `order_lines` (`ToTable("order_lines", "fulfilment")`, no access),
  `shipments` (dapper; columns from `schema.sql`).
- Data access: `OrderRepository` (efcore: `FindAsync` read, `CreateAsync` create, `CancelAsync` read + delete) and
  `ShipmentRepository` (dapper: `ForOrderAsync` read, `RecordAsync` create). Callers reach them through `INJECTS`:
  `OrdersController` routes (`OrderService` is registered as a concrete class) `GET /api/orders/{id}` (read), `POST /api/orders` (create), `DELETE /api/orders/{id}` (read, delete),
  the minimal route `GET /minimal/orders/{id}` (read), `ShipmentsController` routes `GET /api/shipments/{orderId}` (read) and
  `POST /api/shipments/{orderId}/dispatch` (create). The other minimal routes (`/health`, `/api/stock/...`, `/api/prices/...`)
  and the program `main` entrypoint access no table: a lambda only reaches what is called inside it.
- Env / config: `ConnectionStrings:Fulfilment` (password `<redacted>`, read by `Program.cs` and `ShipmentRepository`), `Carriers:*` (read
  through `IOptions<CarrierOptions>` in `ShipmentService`; `Carriers:ApiKey` redacted), `Services:Inventory:BaseUrl` and
  `Services:Pricing:BaseUrl`, with `USES_ENV` `config override` to `ConnectionStrings__Fulfilment`, `Services__Inventory__BaseUrl`,
  `Services__Pricing__BaseUrl`; `FULFILMENT_REGION` (`ShipmentService.DispatchAsync`) and `WEBSITE_SITE_NAME` (the `/health` lambda only).
- Outbound requests (`api_consumers`): `InventoryClient` (`httpclient-factory`) `GET /api/stock/{sku}` and `POST /api/stock/{sku}/reserve`
  and the Refit `IPricingApi.PriceAsync` `GET /api/prices/{sku}`, which match the service's own minimal routes (the loopback base
  addresses of `appsettings.json`). `IPricingApi.QuoteAsync` is never called and `/api/quotes` is no route here: no consumer.
- `impact_of` `ShipmentRepository.RecordAsync` reaches `POST /api/shipments/{orderId}/dispatch`; `OrderRepository.CreateAsync` and
  `InventoryClient.ReserveAsync` reach `POST /api/orders`; all through the DI-injected interfaces.

Known limit: `impact_of` and `route_details` link a minimal-API lambda to its enclosing `<top-level>` function, so a change under one lambda also lists
the other minimal routes as reached; the data-access, env and config facts above are per lambda.

# csharp-http-clients

Outbound HTTP of a C# gateway (Phase 47, track D): `HttpClient` calls, `IHttpClientFactory` typed and named clients, Refit interfaces. The
requests are recorded on the Call nodes (`httpClient`, `httpMethod`, `httpUrl`) and `js-ts.http-requests` links them to the routes of the same
project (REQUESTS). The base addresses are read from `appsettings.json` (`appsettings.Production.json` has another Orders URL; the
environment-less file wins).

## Expected requests (`Call.httpClient` `httpMethod` `httpUrl` before the linker turns localhost URLs into paths)

Typed clients (`AddHttpClient<OrdersClient>`, `AddHttpClient<IInventoryClient, InventoryClient>`; label `httpclient-factory`):

- `OrdersClient.GetOrderAsync`   GET    `http://localhost:5001/api/orders/${id}` (constant `Root` resolved)
- `OrdersClient.PlaceAsync`      POST   `http://localhost:5001/api/orders`
- `OrdersClient.CancelAsync`     DELETE `http://localhost:5001/api/orders/${id}` (the query is dropped)
- `OrdersClient.RawAsync`        GET    `${path}` (base not joined to an unknown URL; no request is linked)
- `InventoryClient.GetStockAsync`  GET  `http://localhost:5002/api/inventory/${sku}` (base ends with `/`; relative path without a leading slash)
- `InventoryClient.ReserveAsync`   PUT  `http://localhost:5002/api/inventory/${sku}/reserve` (on `new HttpRequestMessage`, sent through a local)
- `InventoryClient.IsHealthyAsync` GET  `http://localhost:5002/api/inventory/health` (`new HttpRequestMessage(..., new Uri(..., UriKind.Relative))` sent in place)

Named clients (`factory.CreateClient("billing")`; label `httpclient-factory`):

- `BillingGateway.InvoicesAsync` GET  `http://localhost:5003/api/billing/invoices` (client in a local)
- `BillingGateway.IssueAsync`    POST `http://localhost:5003/api/billing/invoices` (`CreateClient("billing")` used in place)
- `BillingGateway.AuditAsync`    GET  `${config:Services:Audit:BaseUrl}/api/audit/events` (field set in the constructor; the key is in no appsettings file)

Plain `HttpClient` (label `httpclient`):

- `StatusProbe.PingAsync`    GET `http://localhost:5002/api/inventory/health` (`new HttpClient { BaseAddress = ... }`)
- `StatusProbe.LegacyAsync`  GET `http://localhost:5004/api/legacy/ping` (absolute URL: credentials and query dropped, no base)
- `StatusProbe.LegacyAsync`  GET `${legacy}/api/legacy/status` (a configuration read held in a local is not resolved)
- `StatusProbe.DynamicAsync` GET `${url}` (unresolved)

Refit (label `refit`, on each call of an interface method):

- `CatalogService.FindAsync`   GET    `http://localhost:5006/api/catalog/products/${id}` (`AddRefitClient<ICatalogApi>().ConfigureHttpClient`)
- `CatalogService.AddAsync`    POST   `http://localhost:5006/api/catalog/products`
- `CatalogService.RemoveAsync` DELETE `http://localhost:5006/api/catalog/products/${id}` (`[Headers]` ignored)
- `ShippingService.StatusAsync` GET   `http://localhost:5005/api/shipping/${orderId}/status` (`RestService.For<IShippingApi>("...")`)
- `catalog.Describe()` has no attribute: no request.

Negative: `ResponseCache` (a scanned class with `GetAsync` / `PostAsync` methods, called with `/api/orders/1`) makes no request.

## Expected REQUESTS

`js-ts.http-requests` links the localhost URLs to the routes of the project: `OrdersController` (`GET|POST|DELETE /api/orders[/{id}]`) and the
minimal API routes for inventory, billing, catalog and shipping. Not linked: `RawAsync`, `AuditAsync` (unresolved base), the credentialed
`legacy` calls (no such route), `DynamicAsync`.

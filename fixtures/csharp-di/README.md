# csharp-di

An ASP.NET Core shop service wired with Microsoft.Extensions.DependencyInjection (Phase 46, track D). Registrations are in
`ServiceCollectionExtensions.cs` (`AddShop`, called from `Program.cs` through `builder.Services`).

## Expected facts

Providers (`diStereotype` = lifetime, `diBeanName` = class name): SqlOrderRepository Scoped, OrderService Scoped,
SystemClock Singleton, CheckoutService Transient, OrderProjector Scoped, ReportBuilder Scoped (`TryAddScoped`),
EmailNotifier and SmsNotifier Transient, PricingEngine Scoped (factory `sp => new PricingEngine(..)`), AuditLog Singleton
(instance), Repository Scoped (open generic `typeof(IRepository<>)`), MemoryCache and RedisCache Singleton (keyed),
PaymentGateway Transient (`AddHttpClient`). `FlatTax` is NOT a provider (the `ITaxPolicy` factory calls a helper: unknown type).

`INJECTS` (consumer -> implementation, `fieldName`, `via`):
- constructor: OrderService -> SqlOrderRepository, SystemClock; CheckoutService (two public constructors: the one with
  two parameters) -> SqlOrderRepository, SystemClock; SqlOrderRepository -> AuditLog; PricingEngine -> SystemClock;
  ReminderWorker (`AddHostedService`) -> OrderService; ReportBuilder -> EmailNotifier, SmsNotifier (`IEnumerable<INotifier>`);
  OrdersController -> OrderService, Repository (`IRepository<Order>` through the open generic), EmailNotifier and SmsNotifier
  (`IEnumerable<INotifier>`).
- primary-constructor: OrderProjector (record) -> SqlOrderRepository, PricingEngine; ReportsController -> ReportBuilder,
  SystemClock, PaymentGateway.
- from-services: OrdersController.Price -> PricingEngine (`[FromServices]`), RedisCache (`[FromKeyedServices("redis")]`),
  MemoryCache (`[FromKeyedServices("memory")]`).

Ambiguous: `OrdersController.ambiguousInjections = 1` (the single `INotifier` parameter has two implementations).

Nothing: `ILogger<T>`, `IOptions<ShopOptions>`, `HttpClient` (outside the scan); `ITaxPolicy` (a factory of unknown type is
one candidate, never linked, not counted); `IFormatter` (no registration); `Scratch` (not registered, so not a consumer).

`impact_of` on `SqlOrderRepository.Save` (or `IOrderRepository.Save`) reaches `OrderService.Place`,
`OrdersController.Create` and `ReminderWorker.ExecuteAsync` through the injected interface.

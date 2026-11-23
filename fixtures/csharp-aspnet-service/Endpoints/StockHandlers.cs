using Inventory.Service.Domain;

namespace Inventory.Service.Endpoints;

public static class StockHandlers
{
    // A method-group handler: `service` is injected, `sku` binds from the route, the token from the framework.
    public static IResult Peek(string sku, IStockService service, CancellationToken cancellation) =>
        service.Lookup(sku) is { } item ? Results.Ok(item) : Results.NotFound();

    public static IResult Notify(INotifier notifier, string message)
    {
        notifier.Notify(message);
        return Results.Accepted();
    }
}

using Grpc.Core;
using Inventory.Service.Domain;

namespace Inventory.Service.Grpc;

public class StockGrpcService : Stocker.StockerBase
{
    private readonly IStockService _stock;

    public StockGrpcService(IStockService stock)
    {
        _stock = stock;
    }

    public override Task<ReserveReply> Reserve(ReserveRequest request, ServerCallContext context)
    {
        return Task.FromResult(new ReserveReply { Ok = _stock.Reserve(request.Sku, request.Quantity) });
    }

    public override Task<ReserveReply> Check(CheckRequest request, ServerCallContext context)
    {
        return Task.FromResult(new ReserveReply { Ok = _stock.Lookup(request.Sku) is not null });
    }
}

// A client of the same service, injected through DI.
public class StockProbe
{
    private readonly Stocker.StockerClient _client;

    public StockProbe(Stocker.StockerClient client)
    {
        _client = client;
    }

    public bool IsKnown(string sku) => _client.Check(new CheckRequest { Sku = sku }).Ok;
}

using Grpc.Core;

namespace Acme.Greet.Server.Services;

// Neither the generated base nor a proto of this service is in the scan: the gRPC signature decides.
public class InventoryService : Inventory.InventoryBase
{
    public override Task<StockReply> GetStock(StockRequest request, ServerCallContext context)
        => Task.FromResult(new StockReply());

    // Not an rpc: no ServerCallContext.
    public override int GetHashCode() => 1;
}

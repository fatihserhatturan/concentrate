using Fulfilment.Service.Options;
using Fulfilment.Service.Repositories;
using Microsoft.Extensions.Options;

namespace Fulfilment.Service.Services;

public interface IShipmentService
{
    Task<IEnumerable<Shipment>> ListAsync(int orderId);
    Task<int> DispatchAsync(int orderId);
}

public class ShipmentService : IShipmentService
{
    private readonly IShipmentRepository _shipments;
    private readonly CarrierOptions _carrier;

    public ShipmentService(IShipmentRepository shipments, IOptions<CarrierOptions> carrier)
    {
        _shipments = shipments;
        _carrier = carrier.Value;
    }

    public Task<IEnumerable<Shipment>> ListAsync(int orderId) => _shipments.ForOrderAsync(orderId);

    public Task<int> DispatchAsync(int orderId)
    {
        var region = Environment.GetEnvironmentVariable("FULFILMENT_REGION") ?? "eu";
        return _shipments.RecordAsync(orderId, $"{region}-{_carrier.Endpoint.Length}-{orderId}");
    }
}

using Fulfilment.Service.Clients;
using Fulfilment.Service.Data;
using Fulfilment.Service.Repositories;

namespace Fulfilment.Service.Services;

public class OrderService
{
    private readonly IOrderRepository _orders;
    private readonly InventoryClient _inventory;
    private readonly IPricingApi _pricing;

    public OrderService(IOrderRepository orders, InventoryClient inventory, IPricingApi pricing)
    {
        _orders = orders;
        _inventory = inventory;
        _pricing = pricing;
    }

    public Task<Order?> GetAsync(int id) => _orders.FindAsync(id);

    public async Task<int> PlaceAsync(Order order)
    {
        foreach (var line in order.Lines)
        {
            await _pricing.PriceAsync(line.Sku);
            await _inventory.ReserveAsync(line.Sku, line.Quantity);
        }
        return await _orders.CreateAsync(order);
    }

    public Task CancelAsync(int id) => _orders.CancelAsync(id);
}

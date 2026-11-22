using Shop.Core.Abstractions;
using Shop.Core.Domain;
using Shop.Data.Repositories;

namespace Shop.Web.Services;

public class CheckoutService
{
    private readonly OrderRepository _orders;
    private readonly IClock _clock;

    public CheckoutService(OrderRepository orders, IClock clock)
    {
        _orders = orders;
        _clock = clock;
    }

    public async Task<Order> PlaceAsync(string sku, int quantity, decimal price)
    {
        var order = new Order(Guid.NewGuid(), _clock);
        order.AddLine(sku, quantity, price);
        await _orders.SaveAsync(order);
        return order;
    }
}

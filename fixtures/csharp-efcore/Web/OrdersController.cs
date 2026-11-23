using Microsoft.AspNetCore.Mvc;
using Shop.Models;
using Shop.Repositories;

namespace Shop.Web;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    private readonly OrderRepository _orders;

    public OrdersController(OrderRepository orders)
    {
        _orders = orders;
    }

    [HttpGet]
    public Task<List<Order>> Open() => _orders.OpenAsync();

    [HttpPost]
    public async Task<IActionResult> Create(Order order)
    {
        await _orders.AddAsync(order);
        return Ok();
    }
}

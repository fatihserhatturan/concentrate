using Fulfilment.Service.Data;
using Fulfilment.Service.Services;
using Microsoft.AspNetCore.Mvc;

namespace Fulfilment.Service.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    private readonly OrderService _orders;

    public OrdersController(OrderService orders) => _orders = orders;

    [HttpGet("{id}")]
    public async Task<IActionResult> Get(int id) => Ok(await _orders.GetAsync(id));

    [HttpPost]
    public async Task<IActionResult> Place(Order order) => Ok(await _orders.PlaceAsync(order));

    [HttpDelete("{id}")]
    public async Task<IActionResult> Cancel(int id)
    {
        await _orders.CancelAsync(id);
        return NoContent();
    }
}

using Gateway.Clients;
using Microsoft.AspNetCore.Mvc;

namespace Gateway.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok(new { id });

    [HttpPost]
    public IActionResult Create([FromBody] Order order) => Created("/api/orders/1", order);

    [HttpDelete("{id}")]
    public IActionResult Cancel(int id) => NoContent();
}

[ApiController]
[Route("api/checkout")]
public class CheckoutController(OrdersClient orders, IInventoryClient inventory) : ControllerBase
{
    [HttpPost("{orderId}")]
    public async Task<IActionResult> Checkout(int orderId)
    {
        var order = await orders.GetOrderAsync(orderId);
        await inventory.ReserveAsync("sku-" + orderId);
        return Ok(order);
    }
}

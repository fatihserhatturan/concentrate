using Ledger.Data;
using Microsoft.AspNetCore.Mvc;

namespace Ledger.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    private readonly OrderRepository _orders;
    private readonly CustomerRepository _customers;

    public OrdersController(OrderRepository orders, CustomerRepository customers)
    {
        _orders = orders;
        _customers = customers;
    }

    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok(_orders.Find(id));

    [HttpPost("{id}/close")]
    public async Task<IActionResult> Close(int id) => Ok(await _orders.CloseAsync(id));

    [HttpPut("customers/{id}")]
    public async Task<IActionResult> Rename(int id, string name)
    {
        await _customers.RenameAsync(id, name);
        return NoContent();
    }
}

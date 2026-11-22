using Inventory.Service.Domain;
using Microsoft.AspNetCore.Mvc;

namespace Inventory.Service.Controllers;

[ApiController]
[Route("api/[controller]")]
public class StockController : ControllerBase
{
    private readonly IStockService _stock;

    public StockController(IStockService stock)
    {
        _stock = stock;
    }

    [HttpGet("{sku}")]
    public IActionResult Get(string sku) => _stock.Lookup(sku) is { } item ? Ok(item) : NotFound();

    [HttpPost("{sku}/reserve")]
    public IActionResult Reserve(string sku, [FromQuery] int quantity) => _stock.Reserve(sku, quantity) ? Ok() : Conflict();
}

[ApiController]
[Route("api/alerts")]
public class AlertsController(INotifier notifier) : ControllerBase
{
    // INotifier has two implementations: the primary-constructor point is ambiguous.
    [HttpPost]
    public IActionResult Raise([FromBody] string message)
    {
        notifier.Notify(message);
        return Accepted();
    }
}

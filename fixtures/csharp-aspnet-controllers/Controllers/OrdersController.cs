using Microsoft.AspNetCore.Mvc;

namespace Catalog.Api.Controllers;

[ApiController]
[Route("api/orders")]
[Route("api/v2/orders")]
public class OrdersController(IOrderService orders) : ControllerBase
{
    [HttpGet("{id}")]
    public IActionResult Get(int id) => Ok(orders.Find(id));

    [HttpPost("{id}/ship")]
    public IActionResult Ship(int id) => Accepted();

    [HttpGet]
    [ActionName("all")]
    [Route("[action]")]
    public IActionResult ListAll() => Ok();

    [HttpDelete(Routes.OrderById)]
    public IActionResult Cancel(int id) => NoContent();

    // No verb attribute: every HTTP method answers at the class route.
    public IActionResult Anything() => Ok();
}

public interface IOrderService
{
    object? Find(int id);
}

public static class Routes
{
    public const string OrderById = "{id}/cancel";
}

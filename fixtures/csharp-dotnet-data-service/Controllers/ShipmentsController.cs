using Fulfilment.Service.Services;
using Microsoft.AspNetCore.Mvc;

namespace Fulfilment.Service.Controllers;

[ApiController]
[Route("api/shipments")]
public class ShipmentsController : ControllerBase
{
    private readonly IShipmentService _shipments;

    public ShipmentsController(IShipmentService shipments) => _shipments = shipments;

    [HttpGet("{orderId}")]
    public async Task<IActionResult> List(int orderId) => Ok(await _shipments.ListAsync(orderId));

    [HttpPost("{orderId}/dispatch")]
    public async Task<IActionResult> Dispatch(int orderId) => Ok(await _shipments.DispatchAsync(orderId));
}

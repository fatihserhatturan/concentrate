using Microsoft.AspNetCore.Mvc;

namespace Catalog.Api.Controllers;

[ApiController]
[Route("api/v1/[controller]")]
public abstract class ApiControllerBase : ControllerBase
{
    [HttpGet("ping")]
    public IActionResult Ping() => Ok("pong");

    [HttpGet("version")]
    public virtual IActionResult Version() => Ok("1");

    protected IActionResult Missing() => NotFound();

    [NonAction]
    public IActionResult Helper() => Ok();
}

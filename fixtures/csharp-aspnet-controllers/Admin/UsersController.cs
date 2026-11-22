using Microsoft.AspNetCore.Mvc;

namespace Catalog.Api.Admin;

[Area("Admin")]
[Route("[area]/[controller]/[action]")]
public class UsersController : Controller
{
    [HttpGet]
    public IActionResult Index() => View();

    [HttpPost("/admin/users/reset")]
    public IActionResult ResetAll() => Ok();
}

// Not controllers: no ControllerBase / [ApiController] / [Controller].
public class UserService
{
    [Route("not-a-route")]
    public string Name() => "x";
}

[Route("api/audit")]
public class AuditJob
{
    [HttpGet]
    public string Run() => "x";
}

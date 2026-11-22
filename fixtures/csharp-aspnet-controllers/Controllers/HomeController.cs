using Microsoft.AspNetCore.Mvc;

namespace Catalog.Api.Controllers;

// A classic MVC controller: no [ApiController], conventional routing for actions without attributes.
public class HomeController : Controller
{
    public IActionResult Index() => View();

    public IActionResult About() => View();

    [HttpPost]
    public IActionResult Contact() => View();

    [Route("terms")]
    public IActionResult Terms() => View();

    [NonAction]
    public string Format(string value) => value;

    public override void OnActionExecuting(Microsoft.AspNetCore.Mvc.Filters.ActionExecutingContext context) { }
}

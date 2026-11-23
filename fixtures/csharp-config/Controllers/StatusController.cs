using Microsoft.AspNetCore.Mvc;

namespace ConfigDemo.Controllers;

[ApiController]
[Route("api/status")]
public class StatusController : ControllerBase
{
    private readonly IConfiguration _configuration;

    public StatusController(IConfiguration configuration)
    {
        _configuration = configuration;
    }

    [HttpGet]
    public string Get() => _configuration["Status:Banner"] ?? "unknown";

    [HttpGet("env")]
    public string Deployment() => System.Environment.GetEnvironmentVariable("DEPLOY_ENV") ?? "dev";
}

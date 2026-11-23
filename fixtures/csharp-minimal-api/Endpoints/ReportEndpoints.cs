using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Routing;

namespace Todos.Api.Endpoints;

public static class ReportEndpoints
{
    // An extension method on IEndpointRouteBuilder: its group is relative to wherever the caller mounts it.
    public static IEndpointRouteBuilder MapTodoReports(this IEndpointRouteBuilder endpoints)
    {
        var reports = endpoints.MapGroup("/reports");
        reports.MapGet("/", (ITodoService todos) => new { total = todos.Count() });
        reports.MapGet("/open", OpenReport);

        RouteGroupBuilder nested = reports.MapGroup("/daily");
        nested.MapPost("/", () => Results.Accepted());

        return endpoints;

        static IResult OpenReport(ITodoService todos) => Results.Ok(todos.All().Where(todo => !todo.Done));
    }
}

public class LegacyStartup
{
    public void Configure(IApplicationBuilder app)
    {
        app.UseRouting();
        // The middleware branch (IApplicationBuilder.Map) is not a route.
        app.Map("/branch", branch => branch.Run(context => context.Response.WriteAsync("branch")));
        app.UseEndpoints(endpoints =>
        {
            endpoints.MapGet("/legacy", async context => await context.Response.WriteAsync("legacy"));
        });
    }
}

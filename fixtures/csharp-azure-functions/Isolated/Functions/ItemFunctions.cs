using System.Net;
using Microsoft.Azure.Functions.Worker;
using Microsoft.Azure.Functions.Worker.Http;

namespace Orders.Functions;

public class ItemFunctions
{
    [Function("GetItem")]
    public HttpResponseData GetItem(
        [HttpTrigger(AuthorizationLevel.Function, "get", Route = "items/{id:int}")] HttpRequestData req,
        int id)
    {
        return req.CreateResponse(HttpStatusCode.OK);
    }

    [Function("SaveItem")]
    public HttpResponseData SaveItem(
        [HttpTrigger(AuthorizationLevel.Function, "post", "put", Route = "items")] HttpRequestData req)
    {
        return req.CreateResponse(HttpStatusCode.Created);
    }

    // No verbs, no Route: every method, the function name is the path.
    [Function("Ping")]
    public HttpResponseData Ping([HttpTrigger(AuthorizationLevel.Anonymous)] HttpRequestData req)
    {
        return req.CreateResponse(HttpStatusCode.OK);
    }

    // A constant as the route: the path is not guessed.
    [Function("Health")]
    public HttpResponseData Health([HttpTrigger(AuthorizationLevel.Anonymous, "get", Route = Routes.Health)] HttpRequestData req)
    {
        return req.CreateResponse(HttpStatusCode.OK);
    }

    // Not a function: no [Function] attribute, so the trigger does nothing.
    public void NotAFunction([QueueTrigger("ignored")] string message)
    {
    }
}

public static class Routes
{
    public const string Health = "healthz";
}

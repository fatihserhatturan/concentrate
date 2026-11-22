using System.Threading.Tasks;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Azure.WebJobs;
using Microsoft.Azure.WebJobs.Extensions.Http;

namespace Legacy.Functions
{
    public static class LegacyFunctions
    {
        [FunctionName("LegacyHttp")]
        public static async Task<IActionResult> Run(
            [HttpTrigger(AuthorizationLevel.Function, "get", "post", Route = "legacy/{id}")] HttpRequest req,
            string id)
        {
            return new OkObjectResult(id);
        }

        [FunctionName("LegacyTimer")]
        public static void Tick([TimerTrigger("0 0 * * * *")] TimerInfo timer)
        {
        }

        [FunctionName("LegacyQueue")]
        public static void Dequeue([QueueTrigger("legacy-orders")] string message)
        {
        }
    }
}

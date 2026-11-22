using Microsoft.Azure.Functions.Worker;
using Microsoft.Extensions.Logging;

namespace Orders.Functions;

public class BackgroundFunctions(ILogger<BackgroundFunctions> logger)
{
    [Function("Cleanup")]
    public void Cleanup([TimerTrigger("0 */5 * * * *")] TimerInfo timer)
    {
        logger.LogInformation("Cleaning up");
    }

    // A setting placeholder: resolved by the host at run time.
    [Function("NightlyReport")]
    public void NightlyReport([TimerTrigger("%ReportSchedule%")] TimerInfo timer)
    {
    }

    [Function("ProcessOrder")]
    public void ProcessOrder([QueueTrigger("orders", Connection = "StorageConnection")] string message)
    {
        logger.LogInformation("Order {Message}", message);
    }

    // A constant as the queue name.
    [Function("ProcessRefund")]
    public void ProcessRefund([QueueTrigger(QueueNames.Refunds)] string message)
    {
    }

    [Function("OnUpload")]
    public void OnUpload([BlobTrigger("uploads/{name}", Connection = "StorageConnection")] Stream blob, string name)
    {
    }

    [Function("OnAlert")]
    public void OnAlert([ServiceBusTrigger("alerts", "billing", Connection = "Bus")] string message)
    {
    }

    [Function("OnTelemetry")]
    public void OnTelemetry([EventHubTrigger("telemetry", Connection = "Hub")] string[] events)
    {
    }

    [Function("OnItemChange")]
    public void OnItemChange([CosmosDBTrigger("shop", "items", Connection = "Cosmos")] IReadOnlyList<string> changes)
    {
    }
}

public static class QueueNames
{
    public const string Refunds = "refunds";
}

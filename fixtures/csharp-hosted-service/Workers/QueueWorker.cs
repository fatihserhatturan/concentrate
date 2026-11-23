using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace HostedServices.Workers;

// A BackgroundService: the host calls ExecuteAsync once at start-up.
public class QueueWorker(ILogger<QueueWorker> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            logger.LogInformation("Polling the queue");
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken);
        }
    }
}

using Microsoft.Extensions.Hosting;

namespace HostedServices.Workers;

// Never passed to AddHostedService in this project (a library or another host may register it).
public class CleanupService : BackgroundService
{
    protected override Task ExecuteAsync(CancellationToken stoppingToken) => Task.CompletedTask;
}

// Not a hosted service: its own methods carry the same names.
public class Scheduler
{
    public Task StartAsync(CancellationToken cancellationToken) => Task.CompletedTask;

    public Task ExecuteAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

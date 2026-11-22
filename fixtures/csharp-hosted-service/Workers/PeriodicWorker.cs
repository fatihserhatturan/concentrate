using Microsoft.Extensions.Hosting;

namespace HostedServices.Workers;

// Abstract: never run by itself, only its concrete subclasses are.
public abstract class PeriodicWorker : BackgroundService
{
    protected abstract TimeSpan Period { get; }

    protected abstract Task TickAsync(CancellationToken cancellationToken);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Period);
        while (await timer.WaitForNextTickAsync(stoppingToken))
        {
            await TickAsync(stoppingToken);
        }
    }
}

// Inherits ExecuteAsync from PeriodicWorker: the entrypoint is the base class's method.
public class ReportWorker : PeriodicWorker
{
    protected override TimeSpan Period => TimeSpan.FromHours(1);

    protected override Task TickAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

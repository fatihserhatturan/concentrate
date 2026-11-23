using Microsoft.Extensions.Hosting;

namespace HostedServices.Workers;

// An IHostedService: StartAsync is the entrypoint, StopAsync is the other half of the same service.
public sealed class Heartbeat : IHostedService, IDisposable
{
    private Timer? _timer;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _timer = new Timer(_ => Beat(), null, TimeSpan.Zero, TimeSpan.FromSeconds(30));
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        _timer?.Change(Timeout.Infinite, 0);
        return Task.CompletedTask;
    }

    public void Dispose() => _timer?.Dispose();

    private static void Beat() => Console.WriteLine("beat");
}

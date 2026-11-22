using Inventory.Service.Domain;
using Microsoft.Extensions.Hosting;

namespace Inventory.Service.Workers;

public class ReplenishWorker : BackgroundService
{
    private readonly IStockService _stock;

    public ReplenishWorker(IStockService stock)
    {
        _stock = stock;
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            _stock.Replenish();
            await Task.Delay(TimeSpan.FromMinutes(5), stoppingToken);
        }
    }
}

public class AuditFlusher : IHostedService
{
    private readonly INotifier _notifier;
    private readonly IStockRepository _repository;

    public AuditFlusher(INotifier notifier, IStockRepository repository)
    {
        _notifier = notifier;
        _repository = repository;
    }

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _repository.Save(new StockItem("audit", 0));
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

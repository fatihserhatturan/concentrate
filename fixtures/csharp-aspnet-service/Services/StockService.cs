using Inventory.Service.Domain;

namespace Inventory.Service.Services;

public class StockService : IStockService
{
    private readonly IStockRepository _repository;
    private readonly IClock _clock;

    public StockService(IStockRepository repository, IClock clock)
    {
        _repository = repository;
        _clock = clock;
    }

    public StockItem? Lookup(string sku) => _repository.Find(sku);

    public bool Reserve(string sku, int quantity)
    {
        var item = _repository.Find(sku);
        if (item is null || item.Quantity < quantity) return false;
        _repository.Save(item with { Quantity = item.Quantity - quantity });
        return true;
    }

    public void Replenish()
    {
        _repository.Save(new StockItem("restock-" + _clock.UtcNow.Ticks, 10));
    }
}

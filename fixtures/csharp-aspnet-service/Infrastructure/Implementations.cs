using Inventory.Service.Domain;

namespace Inventory.Service.Infrastructure;

public class SqlStockRepository : IStockRepository
{
    private readonly Dictionary<string, StockItem> _rows = new();

    public StockItem? Find(string sku) => _rows.GetValueOrDefault(sku);

    public void Save(StockItem item) => _rows[item.Sku] = item;
}

public class EmailNotifier : INotifier
{
    public void Notify(string message) { }
}

public class SmsNotifier : INotifier
{
    public void Notify(string message) { }
}

public class SystemClock : IClock
{
    public DateTime UtcNow => DateTime.UtcNow;
}

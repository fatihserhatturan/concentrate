namespace Inventory.Service.Domain;

public record StockItem(string Sku, int Quantity);

// One implementation (SqlStockRepository).
public interface IStockRepository
{
    StockItem? Find(string sku);
    void Save(StockItem item);
}

// One implementation (StockService).
public interface IStockService
{
    StockItem? Lookup(string sku);
    bool Reserve(string sku, int quantity);
    void Replenish();
}

// Two implementations (EmailNotifier, SmsNotifier): injecting it is ambiguous.
public interface INotifier
{
    void Notify(string message);
}

public interface IClock
{
    DateTime UtcNow { get; }
}

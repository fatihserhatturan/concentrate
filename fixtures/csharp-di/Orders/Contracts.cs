namespace ShopDi.Orders;

public record Order(int Id, decimal Total);

public interface IOrderRepository
{
    void Save(Order order);
    Order? Load(int id);
}

public interface IOrderService
{
    Order Place(decimal total);
}

public interface IClock
{
    DateTime UtcNow { get; }
}

public interface INotifier
{
    void Notify(string message);
}

public interface IPriceCalculator
{
    decimal Price(Order order);
}

public interface ITaxPolicy
{
    decimal Tax(decimal amount);
}

public interface IAuditLog
{
    void Record(string entry);
}

public interface IRepository<T>
{
    T? Find(int id);
}

public interface ICache
{
    string? Get(string key);
}

public interface IReportBuilder
{
    string Build();
}

public interface IPaymentGateway
{
    bool Charge(Order order);
}

public class ShopOptions
{
    public string Currency { get; set; } = "USD";
}

public static class TaxPolicies
{
    public static ITaxPolicy For(IServiceProvider provider) => new FlatTax();
}

public class FlatTax : ITaxPolicy
{
    public decimal Tax(decimal amount) => amount * 0.2m;
}

using ShopDi.Orders;

namespace ShopDi.Infrastructure;

public class SqlOrderRepository : IOrderRepository
{
    private readonly IAuditLog _audit;

    public SqlOrderRepository(IAuditLog audit) => _audit = audit;

    public void Save(Order order) => _audit.Record($"save {order.Id}");

    public Order? Load(int id) => null;
}

public class SystemClock : IClock
{
    public DateTime UtcNow => DateTime.UtcNow;
}

public class EmailNotifier : INotifier
{
    public void Notify(string message) { }
}

public class SmsNotifier : INotifier
{
    public void Notify(string message) { }
}

public class PricingEngine : IPriceCalculator
{
    private readonly IClock _clock;

    public PricingEngine(IClock clock) => _clock = clock;

    public decimal Price(Order order) => order.Total;
}

public class AuditLog : IAuditLog
{
    public void Record(string entry) { }
}

public class Repository<T> : IRepository<T>
{
    public T? Find(int id) => default;
}

public class MemoryCache : ICache
{
    public string? Get(string key) => null;
}

public class RedisCache : ICache
{
    public string? Get(string key) => null;
}

public class PaymentGateway : IPaymentGateway
{
    private readonly HttpClient _http;

    public PaymentGateway(HttpClient http) => _http = http;

    public bool Charge(Order order) => true;
}

public class ReminderWorker : BackgroundService
{
    private readonly IOrderService _orders;

    public ReminderWorker(IOrderService orders) => _orders = orders;

    protected override Task ExecuteAsync(CancellationToken stoppingToken)
    {
        _orders.Place(0m);
        return Task.CompletedTask;
    }
}

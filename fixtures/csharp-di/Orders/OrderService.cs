using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;

namespace ShopDi.Orders;

public class OrderService : IOrderService
{
    private readonly IOrderRepository _repository;
    private readonly IClock _clock;
    private readonly ILogger<OrderService> _logger;

    public OrderService(IOrderRepository repository, IClock clock, ILogger<OrderService> logger, IOptions<ShopOptions> options)
    {
        _repository = repository;
        _clock = clock;
        _logger = logger;
    }

    public Order Place(decimal total)
    {
        var order = new Order(_clock.UtcNow.Second, total);
        _repository.Save(order);
        _logger.LogInformation("placed {Id}", order.Id);
        return order;
    }
}

// Two public constructors: Microsoft DI takes the one with the most parameters.
public class CheckoutService
{
    private readonly IOrderRepository _repository;
    private readonly IClock? _clock;

    public CheckoutService(IOrderRepository repository)
    {
        _repository = repository;
    }

    public CheckoutService(IOrderRepository repository, IClock clock)
    {
        _repository = repository;
        _clock = clock;
    }

    public void Complete(int id) => _repository.Load(id);
}

// A record with a primary constructor is a consumer too.
public record OrderProjector(IOrderRepository Repository, IPriceCalculator Pricing)
{
    public decimal Total(int id) => Pricing.Price(Repository.Load(id)!);
}

public class ReportBuilder : IReportBuilder
{
    private readonly IEnumerable<INotifier> _notifiers;

    public ReportBuilder(IEnumerable<INotifier> notifiers) => _notifiers = notifiers;

    public string Build() => string.Join(",", _notifiers.Select(n => n.GetType().Name));
}

// Not registered anywhere: never injected, never counted.
public class Scratch
{
    public Scratch(IOrderRepository repository) { }
}

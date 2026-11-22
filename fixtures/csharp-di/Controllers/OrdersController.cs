using Microsoft.AspNetCore.Mvc;
using ShopDi.Orders;

namespace ShopDi.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController : ControllerBase
{
    private readonly IOrderService _orders;
    private readonly IEnumerable<INotifier> _notifiers;
    private readonly INotifier _notifier;
    private readonly IRepository<Order> _repository;

    public OrdersController(IOrderService orders, IEnumerable<INotifier> notifiers, INotifier notifier, IRepository<Order> repository)
    {
        _orders = orders;
        _notifiers = notifiers;
        _notifier = notifier;
        _repository = repository;
    }

    [HttpPost]
    public IActionResult Create(decimal total) => Ok(_orders.Place(total));

    [HttpGet("{id}/price")]
    public IActionResult Price(int id, [FromServices] IPriceCalculator pricing, [FromServices] ITaxPolicy tax, [FromKeyedServices("redis")] ICache cache, [FromKeyedServices("memory")] ICache local)
        => Ok(pricing.Price(new Order(id, 0m)));
}

[ApiController]
[Route("api/reports")]
public class ReportsController(IReportBuilder reports, IClock clock, IPaymentGateway gateway, IFormatter formatter) : ControllerBase
{
    [HttpGet]
    public IActionResult Get() => Ok(reports.Build());
}

// A scanned interface nobody registers: neither linked nor counted.
public interface IFormatter { }

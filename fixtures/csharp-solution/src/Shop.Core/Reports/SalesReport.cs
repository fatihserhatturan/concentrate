using Shop.Core.Domain;

namespace Shop.Core.Reports;

public class SalesReport
{
    private readonly IClock _clock;

    public SalesReport(IClock clock) => _clock = clock;

    public string Summarize(IEnumerable<Order> orders)
    {
        var total = orders.Sum(order => order.Total());
        return $"{_clock.Now:u}: {total}";
    }

    // Negative case: `OrderRecord` is declared in Shop.Data.Models, which Shop.Data's global using brings into scope
    // only inside Shop.Data. Shop.Core does not reference Shop.Data, so this name must stay unresolved.
    public string Describe(OrderRecord record) => record.Id.ToString();
}

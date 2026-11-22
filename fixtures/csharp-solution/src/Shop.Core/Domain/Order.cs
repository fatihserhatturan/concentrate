namespace Shop.Core.Domain;

public record OrderLine(string Sku, int Quantity, decimal UnitPrice);

public class Order
{
    private readonly List<OrderLine> _lines = new();

    public Order(Guid id, IClock clock)
    {
        Id = id;
        PlacedAt = clock.Now;
    }

    public Guid Id { get; }
    public DateTimeOffset PlacedAt { get; }
    public IReadOnlyList<OrderLine> Lines => _lines;

    public void AddLine(string sku, int quantity, decimal unitPrice) => _lines.Add(new OrderLine(sku, quantity, unitPrice));

    public decimal Total() => _lines.Sum(line => line.Quantity * line.UnitPrice);
}

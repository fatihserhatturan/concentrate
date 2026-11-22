namespace Shop.Data.Models;

public class OrderRecord
{
    public Guid Id { get; set; }
    public DateTimeOffset PlacedAt { get; set; }
    public decimal Total { get; set; }
}

namespace Shop.Models;

// Convention: the table is named after the DbSet property (ShopContext.Orders).
public class Order
{
    public int OrderId { get; set; }
    public int CustomerId { get; set; }
    public decimal Total { get; set; }
    public DateTime? ShippedAt { get; set; }
}

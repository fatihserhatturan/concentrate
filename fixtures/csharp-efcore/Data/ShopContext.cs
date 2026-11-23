using Microsoft.EntityFrameworkCore;
using Shop.Models;

namespace Shop.Data;

// A plain context: the tables come from attributes and conventions.
public class ShopContext : DbContext
{
    public ShopContext(DbContextOptions<ShopContext> options) : base(options) { }

    public DbSet<Customer> Customers { get; set; }
    public DbSet<Product> Products => Set<Product>();
    public DbSet<Order> Orders { get; set; }
    public DbSet<AuditView> AuditViews { get; set; }

    // A member of the context itself: an implicit receiver, `this` and Set<T>().
    public Task<int> CountActiveCustomersAsync() => Customers.CountAsync(c => c.Active);

    public void Archive(Order order)
    {
        this.Orders.Remove(order);
        Set<Customer>().Update(new Customer());
    }
}

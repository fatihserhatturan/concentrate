using Microsoft.EntityFrameworkCore;

namespace Fulfilment.Service.Data;

public class FulfilmentDbContext : DbContext
{
    public FulfilmentDbContext(DbContextOptions<FulfilmentDbContext> options) : base(options) { }

    public DbSet<Order> Orders => Set<Order>();
    public DbSet<OrderLine> OrderLines => Set<OrderLine>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<OrderLine>().ToTable("order_lines", "fulfilment");
    }
}

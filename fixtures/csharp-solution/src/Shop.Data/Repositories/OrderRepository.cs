using Microsoft.EntityFrameworkCore;
using Shop.Core.Abstractions;
using Shop.Core.Domain;

namespace Shop.Data.Repositories;

public class ShopContext : DbContext
{
    public DbSet<OrderRecord> Orders => Set<OrderRecord>();
}

public class OrderRepository
{
    private readonly ShopContext _context;
    private readonly IClock _clock;

    public OrderRepository(ShopContext context, IClock clock)
    {
        _context = context;
        _clock = clock;
    }

    public async Task SaveAsync(Order order)
    {
        _context.Orders.Add(new OrderRecord { Id = order.Id, PlacedAt = _clock.Now, Total = order.Total() });
        await _context.SaveChangesAsync();
    }

    public Task<List<OrderRecord>> ListAsync() => _context.Orders.ToListAsync();
}

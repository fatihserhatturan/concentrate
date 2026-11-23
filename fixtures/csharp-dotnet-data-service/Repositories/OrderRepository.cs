using Fulfilment.Service.Data;
using Microsoft.EntityFrameworkCore;

namespace Fulfilment.Service.Repositories;

public interface IOrderRepository
{
    Task<Order?> FindAsync(int id);
    Task<int> CreateAsync(Order order);
    Task CancelAsync(int id);
}

public class OrderRepository : IOrderRepository
{
    private readonly FulfilmentDbContext _db;

    public OrderRepository(FulfilmentDbContext db) => _db = db;

    public Task<Order?> FindAsync(int id) => _db.Orders.Include(o => o.Lines).FirstOrDefaultAsync(o => o.Id == id);

    public async Task<int> CreateAsync(Order order)
    {
        _db.Orders.Add(order);
        await _db.SaveChangesAsync();
        return order.Id;
    }

    public async Task CancelAsync(int id)
    {
        var order = await _db.Orders.FindAsync(id);
        if (order is null) return;
        _db.Orders.Remove(order);
        await _db.SaveChangesAsync();
    }
}

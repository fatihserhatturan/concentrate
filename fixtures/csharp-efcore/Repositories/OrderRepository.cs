using Microsoft.EntityFrameworkCore;
using Shop.Data;
using Shop.Models;

namespace Shop.Repositories;

public class OrderRepository
{
    private const string ShippedSql = "SELECT * FROM Orders WHERE ShippedAt IS NOT NULL";
    private readonly ShopContext _db;

    public OrderRepository(ShopContext db)
    {
        _db = db;
    }

    public Task<List<Order>> OpenAsync() => _db.Orders.Where(o => o.ShippedAt == null).ToListAsync();

    public async Task<Order?> GetAsync(int id) => await _db.Orders.FindAsync(id);

    public async Task AddAsync(Order order)
    {
        await _db.Orders.AddAsync(order);
        await _db.SaveChangesAsync();
    }

    public void Cancel(Order order)
    {
        _db.Orders.Remove(order);
        _db.SaveChanges();
    }

    public Task<int> CountAsync() => _db.Orders.CountAsync();

    public Task<List<string>> CustomerNamesAsync()
    {
        var query = from c in _db.Customers where c.Active select c.Name;
        return query.ToListAsync();
    }

    public Task<int> RepriceAsync(decimal factor) =>
        _db.Set<Product>().ExecuteUpdateAsync(s => s.SetProperty(p => p.Price, p => p.Price * factor));

    public void MarkModified(Order order) => _db.Entry(order).State = EntityState.Modified;

    public Task<List<Order>> ShippedAsync() => _db.Orders.FromSqlRaw(ShippedSql).ToListAsync();

    public Task<int> PurgeAsync(int days) =>
        _db.Database.ExecuteSqlInterpolatedAsync($"DELETE FROM order_archive WHERE age > {days}");

    public Task<List<Customer>> ByDomainAsync(string domain) =>
        _db.Customers.FromSql($"SELECT * FROM Customers WHERE Email LIKE {domain}").ToListAsync();

    public Task<List<Product>> AllProductsRawAsync() => _db.Products.FromSqlRaw("EXEC GetProducts").ToListAsync();
}

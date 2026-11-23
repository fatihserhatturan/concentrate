using Microsoft.EntityFrameworkCore;
using Shop.Data;
using Shop.Models;

namespace Shop.Services;

// Primary-constructor context.
public class ReportService(ShopContext shop)
{
    public Task<decimal> RevenueAsync() => shop.Orders.SumAsync(o => o.Total);

    public Task<bool> HasProductAsync(string sku) => shop.Products.AnyAsync(p => p.Sku == sku);

    public Task<int> CleanupAsync() => shop.Database.ExecuteSqlRawAsync("DELETE FROM Customers WHERE Active = 0");
}

// Local contexts created in place.
public class BillingService
{
    public async Task<List<Invoice>> InvoicesOfAsync(int orderId)
    {
        using var ctx = new BillingContext();
        return await ctx.Invoices.Where(i => i.OrderId == orderId).ToListAsync();
    }

    public async Task PayAsync(Payment payment)
    {
        await using var ctx = new BillingContext();
        ctx.Payments.Add(payment);
        ctx.Lines.AddRange(new InvoiceLine(), new InvoiceLine());
        await ctx.SaveChangesAsync();
    }

    public Task<int> DraftsAsync()
    {
        using var ctx = new BillingContext();
        return ctx.Drafts.CountAsync();
    }
}

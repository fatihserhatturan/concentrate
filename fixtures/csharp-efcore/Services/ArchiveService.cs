using Microsoft.EntityFrameworkCore;
using Shop.Data;

namespace Shop.Services;

// A context made by an IDbContextFactory<T>.
public class ArchiveService
{
    private readonly IDbContextFactory<BillingContext> _factory;

    public ArchiveService(IDbContextFactory<BillingContext> factory)
    {
        _factory = factory;
    }

    public async Task<int> PaymentCountAsync()
    {
        await using var ctx = await _factory.CreateDbContextAsync();
        return await ctx.Payments.CountAsync();
    }
}

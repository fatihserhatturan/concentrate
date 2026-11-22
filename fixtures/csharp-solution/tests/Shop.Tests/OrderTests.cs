using Shop.Core.Abstractions;
using Shop.Core.Domain;

namespace Shop.Tests;

public class OrderTests
{
    private sealed class FixedClock : IClock
    {
        public DateTimeOffset Now => new(2026, 1, 1, 0, 0, 0, TimeSpan.Zero);
    }

    [Fact]
    public void TotalSumsLines()
    {
        var order = new Order(Guid.NewGuid(), new FixedClock());
        order.AddLine("A-1", 2, 3.5m);
        Assert.Equal(7m, order.Total());
    }
}

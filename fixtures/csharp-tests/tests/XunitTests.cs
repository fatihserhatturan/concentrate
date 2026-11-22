using Xunit;

namespace Acme.Tests;

public class XunitTests
{
    [Fact]
    public void Adds() => Assert.Equal(3, new Calculator().Add(1, 2));

    [Theory]
    [InlineData(1, 2, 3)]
    [InlineData(2, 2, 4)]
    public void AddsMany(int a, int b, int expected) => Assert.Equal(expected, new Calculator().Add(a, b));

    public void NotATest() { }
}

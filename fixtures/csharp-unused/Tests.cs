using Xunit;

namespace Acme.App;

public class SomeTests
{
    [Fact]
    public void NeverCalledDirectly() { }      // test method: exempt
}

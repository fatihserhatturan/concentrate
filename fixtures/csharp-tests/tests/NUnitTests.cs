using NUnit.Framework;

namespace Acme.Tests
{
    [TestFixture]
    public class NUnitTests
    {
        [SetUp]
        public void Setup() { }

        [Test]
        public void Adds() => Assert.AreEqual(3, new Calculator().Add(1, 2));

        [TestCase(1, 2, 3)]
        [TestCase(2, 2, 4)]
        public void AddsMany(int a, int b, int e) => Assert.AreEqual(e, new Calculator().Add(a, b));
    }
}

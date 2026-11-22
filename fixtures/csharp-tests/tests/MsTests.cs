using Microsoft.VisualStudio.TestTools.UnitTesting;

namespace Acme.Tests;

[TestClass]
public class MsTests
{
    [TestInitialize]
    public void Init() { }

    [TestMethod]
    public void Adds() => Assert.AreEqual(3, new Calculator().Add(1, 2));

    [DataTestMethod]
    [DataRow(1, 2, 3)]
    public void AddsRow(int a, int b, int e) => Assert.AreEqual(e, new Calculator().Add(a, b));
}

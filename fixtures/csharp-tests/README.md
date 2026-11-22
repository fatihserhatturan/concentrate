# csharp-tests

Expected:
- `tests/XunitTests.cs`, `tests/NUnitTests.cs`, `tests/MsTests.cs` are classified as TEST files (framework `using` plus attributes).
- Test methods: xUnit `Adds` (`[Fact]`), `AddsMany` (`[Theory]` + 2x `[InlineData]`); NUnit `Adds` (`[Test]`), `AddsMany` (2x `[TestCase]`), class `[TestFixture]`; MSTest `Adds` (`[TestMethod]`), `AddsRow` (`[DataTestMethod]`), class `[TestClass]`.
- Not test methods: `XunitTests.NotATest`, lifecycle `Setup` / `Init` (`[SetUp]`, `[TestInitialize]`).
- `src/Calculator.cs` is NOT a test; test files call `Calculator.Add` (resolved).
- `tests/TestHelpers.cs` lives in a `tests/` folder but has no framework attributes or imports: classification depends on the folder convention only; the key assertion is that it has no test methods.

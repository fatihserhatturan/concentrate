import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Track "entry+unused" fills this in: xUnit (`[Fact]`, `[Theory]`), NUnit (`[Test]`, `[TestCase]`) and MSTest
// (`[TestMethod]`) methods set `Function.testKind`, and their files become test files.
export const csharpTestsContributor: ISemanticContributor = {
  id: "csharp.tests",
  contribute() {
    // Stub: no tests classified yet.
  },
};

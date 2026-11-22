import type { LanguageDescriptor } from "../../../core/contracts/language-descriptor.js";

// Designer output and source generators: `Form1.Designer.cs`, `Model.g.cs`, `Model.g.i.cs`.
export const isCSharpGeneratedFile = (fileName: string): boolean => /\.(?:g|g\.i|Designer)\.cs$/u.test(fileName);

// `FooTests.cs`, `FooTest.cs` (xUnit, NUnit and MSTest project convention). `Test` must start a word, so `Latest.cs` is
// no test. Files under `test/` and `tests/` directories are tests by the directory rule, and a file with a test attribute
// is marked by the C# contributor.
export const isCSharpTestFile = (fileName: string): boolean => /^(?:\w*Tests?)\.cs$/u.test(fileName);

// `.csx` is a C# script. C# files under `obj/` are MSBuild output (generated attributes, `AssemblyInfo.cs`, source-generator output).
export const csharpLanguages: readonly LanguageDescriptor[] = [
  {
    id: "csharp",
    displayName: "C#",
    code: true,
    extensions: [".cs", ".csx"],
    testFile: isCSharpTestFile,
    generatedFile: isCSharpGeneratedFile,
    generatedDirectories: ["obj"],
  },
];

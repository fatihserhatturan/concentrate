import type { LanguageDescriptor } from "../../../core/contracts/language-descriptor.js";

// Designer output and source generators: `Form1.Designer.cs`, `Model.g.cs`, `Model.g.i.cs`.
export const isCSharpGeneratedFile = (fileName: string): boolean => /\.(?:g|g\.i|Designer)\.cs$/u.test(fileName);

// `.csx` is a C# script. Files under `obj/` are MSBuild output (generated attributes, `AssemblyInfo.cs`, source-generator output).
export const csharpLanguages: readonly LanguageDescriptor[] = [
  {
    id: "csharp",
    displayName: "C#",
    code: true,
    extensions: [".cs", ".csx"],
    generatedFile: isCSharpGeneratedFile,
    generatedDirectories: ["obj"],
  },
];

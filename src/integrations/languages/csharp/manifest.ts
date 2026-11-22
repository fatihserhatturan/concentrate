import type { IProjectManifestReader } from "../../../core/contracts/project-manifest.js";

// Wave 2 track C: one Package per C# project (`.csproj`), from `readCSharpProjectModel`.
export const csharpManifestReader: IProjectManifestReader = {
  id: "csharp",
  version: "1",
  readPackages: async () => [],
  readConfig: async () => [],
};

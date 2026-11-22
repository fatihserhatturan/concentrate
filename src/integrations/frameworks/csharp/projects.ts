import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Wave 2 track C: project properties on the Package nodes, `csharp-project` EntryPoints, CS7022 handling.
export const csharpProjectsContributor: ISemanticContributor = {
  id: "csharp.projects",
  dependsOn: ["csharp.entrypoints"],
  async contribute() {
    // Stub.
  },
};

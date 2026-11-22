import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";

// Track "entry+unused" fills this in: `static Main` and top-level statements (`File.hasTopLevelStatements`, the
// `<top-level>` Function of the file) as EntryPoint nodes.
export const csharpEntrypointsContributor: ISemanticContributor = {
  id: "csharp.entrypoints",
  contribute() {
    // Stub: no entry points yet.
  },
};

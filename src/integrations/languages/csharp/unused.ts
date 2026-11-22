import type { IUnusedExportRules } from "../../../core/contracts/unused-rules.js";
import { isCSharpFile } from "../file-kind.js";

// Track "entry+unused" fills this in: `public` and `internal` types and members with C# rules (the assembly is the
// unit for `internal`, `[InternalsVisibleTo]`, attributes a framework reads, `Main`, interface implementations).
// The stub judges nothing.
export const csharpUnusedRules: IUnusedExportRules = {
  id: "csharp",
  languages: ["csharp"],
  supports: isCSharpFile,
  judges: () => false,
  note: "C#: not analysed yet.",
};

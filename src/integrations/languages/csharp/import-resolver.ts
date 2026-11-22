import type { ILanguageImportResolver } from "../../../core/contracts/import-resolver.js";
import { isCSharpFile } from "../file-kind.js";
import { buildCSharpNamespaceIndex } from "./namespaces.js";
import { setCSharpNamespaceIndex } from "./project.js";

// Track "imports" fills this in: a `using` resolves to the files that declare its namespace, `using static` and
// alias targets to the file of their type; `System.*`, `Microsoft.*` and unknown namespaces are expected-unresolved.
// The stub installs the (empty) namespace index and leaves every import unresolved but expected, so the scan
// does not count C# usings against itself.
export const csharpImportResolver: ILanguageImportResolver = {
  id: "csharp",
  supports: isCSharpFile,
  // The session installs the namespace index the call and inheritance resolvers read, so it runs even without Import nodes.
  sessionWithoutImports: true,
  async createSession({ graph }) {
    setCSharpNamespaceIndex(graph, buildCSharpNamespaceIndex(graph));
    return () => ({ fileIds: [], expected: true });
  },
};

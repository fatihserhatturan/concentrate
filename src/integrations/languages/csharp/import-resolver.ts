import type { ILanguageImportResolver } from "../../../core/contracts/import-resolver.js";
import { isCSharpFile } from "../file-kind.js";
import { buildCSharpNamespaceIndex, csharpUsingIndexOf } from "./namespaces.js";
import { readCSharpProjectModel } from "./project/index.js";
import { setCSharpNamespaceIndex, setCSharpProjectModel } from "./project.js";

// A `using X;` resolves to every file declaring namespace X (a namespace spans many files); `using static X.Y;`
// and an alias target resolve to the file(s) declaring the type (every file of a partial type), or to the
// namespace's files when the alias names a namespace. `global using` resolves the same way.
// Unresolved counting (`expected`): `System.*`, `Microsoft.*` and names under a root the scan does not declare
// are external and never counted; a name under one of the scan's own root namespaces (`Acme.*`) that nothing
// declares is counted as unresolved. An ancestor-only namespace is known but has no files and is not counted,
// nor is a `using` of the importer's own namespace (no other file).
export const csharpImportResolver: ILanguageImportResolver = {
  id: "csharp",
  supports: isCSharpFile,
  // The session installs the namespace index the call and inheritance resolvers read, so it runs even without Import nodes.
  sessionWithoutImports: true,
  async createSession({ graph, rootPath, fileIdByRelativePath }) {
    // The model scopes usings and namespace visibility per project (`namespaces.ts` reads it back from the graph).
    setCSharpProjectModel(graph, await readCSharpProjectModel(rootPath, fileIdByRelativePath.keys()));
    const index = buildCSharpNamespaceIndex(graph);
    setCSharpNamespaceIndex(graph, index);
    const usingIndex = csharpUsingIndexOf(index)!;
    return (node, importerFileId, source) => {
      const kind = node.properties.importKind === "static" || node.properties.importKind === "alias" ? node.properties.importKind : "normal";
      const scope = typeof node.properties.usingScope === "string" ? node.properties.usingScope : "";
      const resolution = usingIndex.resolveUsing({ source, kind, scope }, importerFileId);
      const fileIds = resolution.fileIds.filter((id) => id !== importerFileId);
      return { fileIds, expected: resolution.fileIds.length === 0 ? resolution.expected : false };
    };
  },
};

import type { ILanguageImportResolver } from "../../../core/contracts/import-resolver.js";
import { isPythonFile } from "../file-kind.js";
import { readPythonProjects } from "./project.js";
import { createPythonResolver } from "./resolution.js";

// A Python import goes through the project's source roots and `__init__.py` packages.
export const pythonImportResolver: ILanguageImportResolver = {
  id: "python",
  supports: isPythonFile,
  async createSession({ rootPath, fileIdByRelativePath }) {
    const projects = await readPythonProjects(rootPath, fileIdByRelativePath.keys());
    const resolver = createPythonResolver(projects, new Set(fileIdByRelativePath.keys()));
    return (node, importerFileId, source) => {
      const result = resolver.resolveImport({
        importerFile: importerFileId.slice("file:".length),
        source,
        importedName: pythonImportedName(node.properties),
      });
      const fileIds = result.files.map((file) => fileIdByRelativePath.get(file)).filter((id): id is string => id !== undefined);
      if (result.files.length > 0 && result.isModule && node.properties.isWildcard !== true) node.properties.isModule = true;
      return { fileIds, expected: result.files.length === 0 && result.expected };
    };
  },
};

// `x` of `from m import x`: the one named binding of a per-name Import.
function pythonImportedName(properties: Record<string, unknown>): string | null {
  if (typeof properties.bindings !== "string") return null;
  const [binding] = JSON.parse(properties.bindings) as Array<{ imported: string; kind: string }>;
  return binding && binding.kind === "named" ? binding.imported : null;
}

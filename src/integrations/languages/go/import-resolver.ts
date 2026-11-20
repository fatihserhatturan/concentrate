import type { ILanguageImportResolver } from "../../../core/contracts/import-resolver.js";
import { isGoFile } from "../file-kind.js";
import { goPackageDirectory, indexGoFilesByDirectory, readGoResolutionConfig, resolveGoImport } from "./resolution.js";

// A Go import is a package: every file of its directory.
export const goImportResolver: ILanguageImportResolver = {
  id: "go",
  supports: isGoFile,
  async createSession({ rootPath, fileIdByRelativePath }) {
    const config = await readGoResolutionConfig(rootPath, fileIdByRelativePath.keys());
    const filesByDirectory = indexGoFilesByDirectory(fileIdByRelativePath as Map<string, string>);
    return (_node, _importerFileId, source) => {
      if (!source.startsWith(".") && goPackageDirectory(source, config) === null) return { fileIds: [], expected: false };
      return { fileIds: resolveGoImport(source, filesByDirectory, config), expected: true };
    };
  },
};

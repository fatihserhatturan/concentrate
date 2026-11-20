import type { ILanguageImportResolver } from "../../../core/contracts/import-resolver.js";
import { isCppFile } from "../file-kind.js";
import { createCppFileIndex, readCppIncludeConfig, resolveCppInclude } from "./resolution.js";

// An `#include` is a header of the including file's directory, of an
// include directory of compile_commands.json, or external (not counted).
export const cppImportResolver: ILanguageImportResolver = {
  id: "cpp",
  supports: isCppFile,
  async createSession({ rootPath, fileIdByRelativePath }) {
    const index = createCppFileIndex(fileIdByRelativePath.keys());
    const config = await readCppIncludeConfig(rootPath, fileIdByRelativePath.keys());
    return (node, importerFileId, source) => {
      const isSystem = node.properties.isSystem === true;
      const target = resolveCppInclude(source, isSystem, importerFileId.slice("file:".length), index, config);
      const targetFileId = target ? fileIdByRelativePath.get(target) : undefined;
      return { fileIds: targetFileId ? [targetFileId] : [], expected: !isSystem };
    };
  },
};

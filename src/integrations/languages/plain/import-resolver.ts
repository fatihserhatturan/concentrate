import type { ILanguageImportResolver } from "../../../core/contracts/import-resolver.js";
import { isProtoFile, resolveProtoImport } from "./proto-resolution.js";
import { isStyleFile, resolveStyleImport } from "./style-resolution.js";

// A style sheet's imports and `url()`s are paths of the project; a bare Sass
// name may be a package, which is not counted as unresolved.
export const styleImportResolver: ILanguageImportResolver = {
  id: "styles",
  supports: isStyleFile,
  async createSession({ fileIdByRelativePath }) {
    return (_node, importerFileId, source) => {
      const target = resolveStyleImport(source, importerFileId, fileIdByRelativePath);
      return { fileIds: target ? [target] : [], expected: source.startsWith(".") };
    };
  },
};

export const protoImportResolver: ILanguageImportResolver = {
  id: "proto",
  supports: isProtoFile,
  async createSession({ fileIdByRelativePath }) {
    return (_node, importerFileId, source) => {
      const target = resolveProtoImport(source, importerFileId, fileIdByRelativePath);
      return { fileIds: target ? [target] : [], expected: false };
    };
  },
};

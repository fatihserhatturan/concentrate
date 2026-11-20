import type { ILanguageImportResolver } from "../../../core/contracts/import-resolver.js";
import { isJavaFile } from "../file-kind.js";
import { buildJavaPackageIndex } from "./packages.js";

// A Java import goes through the package index: a type import reaches the file declaring the type, a
// wildcard import every file of the package, a static import the file of its class. JDK and unknown
// packages stay unresolved without counting against the scan.
export const javaImportResolver: ILanguageImportResolver = {
  id: "java",
  supports: isJavaFile,
  async createSession({ graph }) {
    const index = buildJavaPackageIndex(graph);
    return (node, importerFileId, source) => {
      const target = index.resolveImport({
        source,
        isWildcard: node.properties.isWildcard === true,
        isStatic: node.properties.isStatic === true,
      });
      return { fileIds: target.fileIds.filter((id) => id !== importerFileId), expected: target.expected };
    };
  },
};

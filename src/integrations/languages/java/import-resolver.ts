import type { ILanguageImportResolver } from "../../../core/contracts/import-resolver.js";
import { isJavaFile } from "../file-kind.js";
import { containedIn, readJavaBuildModel } from "./build/index.js";
import { createJavaModuleFilter, setJavaModuleFilter } from "./module-visibility.js";
import { buildJavaPackageIndex } from "./packages.js";

// A Java import goes through the package index: a type import reaches the file declaring the type, a
// wildcard import every file of the package, a static import the file of its class. JDK and unknown
// packages stay unresolved without counting against the scan.
export const javaImportResolver: ILanguageImportResolver = {
  id: "java",
  supports: isJavaFile,
  async createSession({ graph, rootPath, fileIdByRelativePath }) {
    // The modules of Maven and Gradle build files: their source roots (when a scanned Java file lies in
    // them) join the package index, and a file sees only the modules its module depends on.
    const model = await readJavaBuildModel(rootPath, fileIdByRelativePath.keys());
    const javaFiles = [...fileIdByRelativePath.keys()].filter(isJavaFile);
    const roots = new Set<string>();
    for (const module of model.modules) {
      for (const root of [...module.sourceRoots, ...module.testSourceRoots]) {
        if (javaFiles.some((file) => containedIn(root, file))) roots.add(root);
      }
    }
    const relativePathByFileId = new Map<string, string>();
    for (const [relative, id] of fileIdByRelativePath) relativePathByFileId.set(id, relative);
    const moduleFilter = createJavaModuleFilter(model, relativePathByFileId);
    setJavaModuleFilter(graph, moduleFilter);
    const index = buildJavaPackageIndex(graph, { extraSourceRoots: roots, ...(moduleFilter ? { moduleFilter } : {}) });
    return (node, importerFileId, source) => {
      const target = index.resolveImport(
        {
          source,
          isWildcard: node.properties.isWildcard === true,
          isStatic: node.properties.isStatic === true,
        },
        importerFileId,
      );
      return { fileIds: target.fileIds.filter((id) => id !== importerFileId), expected: target.expected };
    };
  },
};

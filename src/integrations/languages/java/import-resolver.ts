import type { ILanguageImportResolver } from "../../../core/contracts/import-resolver.js";
import { isJavaFile } from "../file-kind.js";
import { containedIn, readJavaBuildModel } from "./build/index.js";
import { createJavaModuleFilter, setJavaModuleFilter } from "./module-visibility.js";
import { buildJavaPackageIndex } from "./packages.js";

// A Java import goes through the package index: a type import reaches the file declaring the type, a
// wildcard import of a package no file (it names a package), a static import the file of its class. JDK and unknown
// packages stay unresolved without counting against the scan.
export const javaImportResolver: ILanguageImportResolver = {
  id: "java",
  supports: isJavaFile,
  // The session installs the module filter the call resolver reads, so it runs even without Import nodes.
  sessionWithoutImports: true,
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
      const isWildcard = node.properties.isWildcard === true;
      const isStatic = node.properties.isStatic === true;
      const target = index.resolveImport({ source, isWildcard, isStatic }, importerFileId);
      const fileIds = target.fileIds.filter((id) => id !== importerFileId);
      // An on-demand import (`import a.b.*`) names a package, not a file: no RESOLVES_TO to any one file of it. The
      // importer depends on the package's files (`packageFileIds`: the build packages it imports, and `affected`
      // follows the same dependency from the Import's source). The call resolver reads the Import node itself.
      if (isWildcard && !isStatic && index.hasPackage(source)) return { fileIds: [], packageFileIds: fileIds, expected: false };
      return { fileIds, expected: target.expected };
    };
  },
};

import { existsSync } from "node:fs";
import path from "node:path";
import type { ILanguageImportResolver } from "../../../core/contracts/import-resolver.js";
import { isJsTsFile } from "../file-kind.js";
import { createJsTsConfiguredImportBasePaths, readJsTsResolutionConfigWithWarnings } from "./resolution/config.js";
import { resolveImport } from "./resolution/import-dispatch.js";

export const jsTsImportResolver: ILanguageImportResolver = {
  id: "js-ts",
  supports: isJsTsFile,
  // A tsconfig.json or package.json that cannot be read is a scan warning, imports or not.
  sessionWithoutImports: true,
  async createSession({ rootPath, fileIdByRelativePath, addWarning }) {
    const config = await readJsTsResolutionConfigWithWarnings(rootPath, (filePath, error) => {
      addWarning({ path: path.relative(rootPath, filePath), message: error instanceof Error ? error.message : String(error) });
    });
    // A bare specifier tried only because of `baseUrl` (`next/link` against
    // `baseUrl: "."`) is a package import, not an unresolved one, unless its
    // first segment names a file or folder under baseUrl (`types` for
    // `types/index.d.ts`). Path aliases, package `imports` and workspace
    // packages are always counted.
    const baseUrlEntries = new Map<string, boolean>();
    const isPackageImport = (source: string): boolean => {
      const baseUrl = config.baseUrl;
      if (source.startsWith(".") || !baseUrl) return false;
      if (createJsTsConfiguredImportBasePaths(source, { ...config, baseUrl: null }).length > 0) return false;
      const segment = source.split("/")[0]!;
      let local = baseUrlEntries.get(segment);
      if (local === undefined) {
        const entry = path.join(rootPath, baseUrl, segment);
        local = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".d.ts"].some((extension) => existsSync(`${entry}${extension}`));
        baseUrlEntries.set(segment, local);
      }
      return !local;
    };
    return (_node, importerFileId, source) => {
      if (!source.startsWith(".") && createJsTsConfiguredImportBasePaths(source, config).length === 0) return { fileIds: [], expected: false };
      const target = resolveImport(source, importerFileId, fileIdByRelativePath as Map<string, string>, config);
      return target ? { fileIds: [target], expected: true } : { fileIds: [], expected: !isPackageImport(source) };
    };
  },
};

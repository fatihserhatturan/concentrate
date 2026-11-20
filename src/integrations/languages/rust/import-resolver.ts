import path from "node:path";
import type { ILanguageImportResolver } from "../../../core/contracts/import-resolver.js";
import { isRustFile } from "../file-kind.js";
import { readCargoConfig } from "./cargo.js";
import { createRustModuleTree, type RustImportRecord } from "./resolution.js";

// A Rust path goes through the Cargo crates and the `mod` tree.
export const rustImportResolver: ILanguageImportResolver = {
  id: "rust",
  supports: isRustFile,
  // The tree puts each file's crate and module on its File node, imports or not.
  sessionWithoutImports: true,
  async createSession({ graph, rootPath, fileIdByRelativePath, importerFileIdByImportId }) {
    const records: RustImportRecord[] = [];
    for (const node of graph.nodesWithLabel("Import")) {
      const importer = importerFileIdByImportId.get(node.id);
      if (importer && isRustFile(importer)) records.push(rustImportRecord(node.properties, importer));
    }
    const config = records.length === 0 ? { packages: [] } : await readCargoConfig(rootPath, fileIdByRelativePath.keys());
    const directories = new Map<string, string[]>();
    for (const file of fileIdByRelativePath.keys()) {
      const dir = path.posix.dirname(file);
      const list = directories.get(dir) ?? [];
      list.push(file);
      directories.set(dir, list);
    }
    const tree = createRustModuleTree(config, records, (file) => fileIdByRelativePath.has(file), (dir) => directories.get(dir) ?? [], [...fileIdByRelativePath.keys()].filter((file) => file.endsWith(".rs")));
    // The call resolver (core) cannot see the tree: each file carries its crate
    // and module path.
    for (const node of graph.nodesWithLabel("File")) {
      if (node.properties.language !== "rust") continue;
      const info = tree.fileInfo(String(node.properties.relativePath).replaceAll("\\", "/"));
      if (!info) continue;
      node.properties.rustCrate = info.crate;
      node.properties.rustCrateName = info.crateName;
      node.properties.rustModule = info.module;
    }
    return (node, importerFileId) => {
      const result = tree.resolveImport(rustImportRecord(node.properties, importerFileId));
      const fileIds = result.files.map((file) => fileIdByRelativePath.get(file)).filter((id): id is string => id !== undefined);
      return { fileIds, expected: result.files.length === 0 && result.expected };
    };
  },
};

function rustImportRecord(properties: Record<string, unknown>, importerFileId: string): RustImportRecord {
  return {
    importerFile: importerFileId.slice("file:".length),
    source: String(properties.source),
    isModule: properties.isModule === true,
    isReExport: properties.isReExport === true,
    isWildcard: properties.isWildcard === true,
    alias: typeof properties.alias === "string" ? properties.alias : null,
    inlineModules: typeof properties.inlineModules === "string" ? JSON.parse(properties.inlineModules) as string[] : [],
    pathAttribute: typeof properties.pathAttribute === "string" ? properties.pathAttribute : null,
  };
}

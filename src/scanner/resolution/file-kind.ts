import path from "node:path";

const absoluteModuleLanguages = new Set(["python"]);

export function isJsTsFile(fileId: string): boolean {
  const extension = fileExtension(fileId);
  return [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].includes(extension);
}

export function isGoFile(fileId: string): boolean {
  return fileExtension(fileId) === ".go";
}

export function isRustFile(fileId: string): boolean {
  return fileExtension(fileId) === ".rs";
}

export function shouldResolveAbsoluteImport(importerFileId: string): boolean {
  const extension = fileExtension(importerFileId);
  return extension === ".py" || absoluteModuleLanguages.has(extension);
}

function fileExtension(fileId: string): string {
  return path.posix.extname(fileId.slice("file:".length));
}

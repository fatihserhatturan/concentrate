import path from "node:path";

export function isJsTsFile(fileId: string): boolean {
  const extension = fileExtension(fileId);
  // Markup files import with JS/TS rules too (`@/components/Card.vue`).
  return [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".html", ".htm", ".vue", ".svelte", ".astro"].includes(extension);
}

export function isGoFile(fileId: string): boolean {
  return fileExtension(fileId) === ".go";
}

export function isPythonFile(fileId: string): boolean {
  return fileExtension(fileId) === ".py";
}

export function isRustFile(fileId: string): boolean {
  return fileExtension(fileId) === ".rs";
}

function fileExtension(fileId: string): string {
  return path.posix.extname(fileId.slice("file:".length));
}

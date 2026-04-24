import path from "node:path";

export type SupportedLanguage = "javascript" | "typescript";

const extensionToLanguage = new Map<string, SupportedLanguage>([
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
]);

export function detectLanguage(filePath: string): SupportedLanguage | null {
  return extensionToLanguage.get(path.extname(filePath)) ?? null;
}

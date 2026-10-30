import path from "node:path";

export type SupportedLanguage = "javascript" | "typescript" | "html" | "vue" | "svelte" | "astro" | "python" | "go" | "rust";

const extensionToLanguage = new Map<string, SupportedLanguage>([
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".html", "html"],
  [".htm", "html"],
  [".vue", "vue"],
  [".svelte", "svelte"],
  [".astro", "astro"],
  [".py", "python"],
  [".go", "go"],
  [".rs", "rust"],
]);

export function detectLanguage(filePath: string): SupportedLanguage | null {
  return extensionToLanguage.get(path.extname(filePath)) ?? null;
}

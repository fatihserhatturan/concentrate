import path from "node:path";

// Languages with a parser that reads declarations, imports and calls.
export type CodeLanguage = "javascript" | "typescript" | "html" | "vue" | "svelte" | "astro" | "python" | "go" | "rust" | "c" | "cpp";

// Every other file of a project is a `File` node too: a known format, `other`
// (text) or `asset` (binary: images, fonts, media, archives).
export type FileLanguage =
  | "css" | "scss" | "less" | "json" | "yaml" | "toml" | "markdown"
  | "shell" | "powershell" | "dockerfile" | "makefile" | "sql" | "proto"
  | "other" | "asset";

export type SupportedLanguage = CodeLanguage | FileLanguage;

export const CODE_LANGUAGES: ReadonlySet<SupportedLanguage> = new Set<CodeLanguage>([
  "javascript", "typescript", "html", "vue", "svelte", "astro", "python", "go", "rust", "c", "cpp",
]);

export function isCodeLanguage(language: SupportedLanguage): language is CodeLanguage {
  return CODE_LANGUAGES.has(language);
}

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
  [".c", "c"],
  // A header is C unless the project has C++ sources (see filterSupportedSourceFiles).
  [".h", "c"],
  [".cc", "cpp"],
  [".cpp", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".hxx", "cpp"],
  [".ipp", "cpp"],
  [".inl", "cpp"],
  [".css", "css"],
  [".scss", "scss"],
  [".sass", "scss"],
  [".less", "less"],
  [".json", "json"],
  [".jsonc", "json"],
  [".json5", "json"],
  [".yml", "yaml"],
  [".yaml", "yaml"],
  [".toml", "toml"],
  [".md", "markdown"],
  [".mdx", "markdown"],
  [".markdown", "markdown"],
  [".sh", "shell"],
  [".bash", "shell"],
  [".zsh", "shell"],
  [".ps1", "powershell"],
  [".psm1", "powershell"],
  [".psd1", "powershell"],
  [".dockerfile", "dockerfile"],
  [".mk", "makefile"],
  [".sql", "sql"],
  [".proto", "proto"],
]);

// Binary formats by extension; any other file is sniffed by its parser.
const assetExtensions = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".icns", ".tif", ".tiff", ".svg",
  ".woff", ".woff2", ".ttf", ".otf", ".eot",
  ".mp3", ".mp4", ".m4a", ".wav", ".ogg", ".webm", ".mov", ".avi", ".flac",
  ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar", ".jar", ".war",
  ".wasm", ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".bin", ".class", ".pyc",
  ".sqlite", ".db", ".psd", ".sketch", ".fig",
]);

function languageByName(fileName: string): SupportedLanguage | null {
  if (fileName === "Dockerfile" || fileName.startsWith("Dockerfile.") || fileName === "Containerfile") return "dockerfile";
  if (fileName === "Makefile" || fileName === "makefile" || fileName === "GNUmakefile") return "makefile";
  return null;
}

export function detectLanguage(filePath: string): SupportedLanguage {
  const fileName = path.basename(filePath);
  const extension = path.extname(fileName).toLowerCase();
  return extensionToLanguage.get(path.extname(fileName))
    ?? languageByName(fileName)
    ?? extensionToLanguage.get(extension)
    ?? (assetExtensions.has(extension) ? "asset" : "other");
}

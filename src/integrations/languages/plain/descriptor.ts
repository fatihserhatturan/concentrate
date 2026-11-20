import type { LanguageDescriptor } from "../../../core/contracts/language-descriptor.js";

// Files that are only `File` nodes: known formats, `other` (text of unknown
// type) and `asset` (binary: images, fonts, media, archives).
export const plainLanguages: readonly LanguageDescriptor[] = [
  // Lockfiles of ecosystems with no code language here (PHP, Ruby).
  { id: "css", code: false, extensions: [".css"], lockfiles: ["composer.lock", "Gemfile.lock"] },
  { id: "scss", code: false, extensions: [".scss", ".sass"] },
  { id: "less", code: false, extensions: [".less"] },
  { id: "json", code: false, extensions: [".json", ".jsonc", ".json5"] },
  { id: "yaml", code: false, extensions: [".yml", ".yaml"] },
  { id: "xml", code: false, extensions: [".xml"] },
  { id: "toml", code: false, extensions: [".toml"] },
  { id: "markdown", code: false, extensions: [".md", ".mdx", ".markdown"] },
  { id: "shell", code: false, extensions: [".sh", ".bash", ".zsh"] },
  { id: "powershell", code: false, extensions: [".ps1", ".psm1", ".psd1"] },
  {
    id: "dockerfile",
    code: false,
    extensions: [".dockerfile"],
    fileNames: ["Dockerfile", "Containerfile"],
    matchFileName: (fileName) => fileName.startsWith("Dockerfile."),
  },
  { id: "makefile", code: false, extensions: [".mk"], fileNames: ["Makefile", "makefile", "GNUmakefile"] },
  { id: "cmake", code: false, extensions: [".cmake"], fileNames: ["CMakeLists.txt"] },
  { id: "sql", code: false, extensions: [".sql"] },
  { id: "proto", code: false, extensions: [".proto"] },
  { id: "other", code: false, fallback: true },
  {
    id: "asset",
    code: false,
    // Binary formats by extension; any other file is sniffed by its parser.
    extensions: [
      ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".icns", ".tif", ".tiff", ".svg",
      ".woff", ".woff2", ".ttf", ".otf", ".eot",
      ".mp3", ".mp4", ".m4a", ".wav", ".ogg", ".webm", ".mov", ".avi", ".flac",
      ".pdf", ".zip", ".gz", ".tgz", ".bz2", ".xz", ".7z", ".rar", ".tar", ".jar", ".war",
      ".wasm", ".exe", ".dll", ".so", ".dylib", ".a", ".o", ".bin", ".class", ".pyc",
      ".sqlite", ".db", ".psd", ".sketch", ".fig",
    ],
  },
];

export function isPlainLanguage(language: string): boolean {
  return plainLanguages.some((descriptor) => descriptor.id === language);
}

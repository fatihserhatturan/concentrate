import { detectLanguage, isCodeLanguage, type SupportedLanguage } from "./language.js";

export type SupportedSourceFile = {
  filePath: string;
  language: SupportedLanguage;
};

// Every discovered file with its language. `maxFiles` limits the code files;
// the other files are always kept (they are not parsed for declarations).
export function filterSupportedSourceFiles(
  files: string[],
  maxFiles: number | undefined,
): SupportedSourceFile[] {
  const all: SupportedSourceFile[] = files.map((filePath) => ({ filePath, language: detectLanguage(filePath) }));
  // `.h` is both C and C++: a project with C++ sources reads its headers as C++.
  if (all.some((file) => file.language === "cpp")) {
    for (const file of all) if (file.language === "c" && file.filePath.endsWith(".h")) file.language = "cpp";
  }
  if (maxFiles === undefined || maxFiles <= 0) return all;
  let code = 0;
  return all.filter((file) => !isCodeLanguage(file.language) || ++code <= maxFiles);
}

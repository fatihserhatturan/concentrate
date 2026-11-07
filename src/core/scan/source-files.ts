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
  const all = files.map((filePath) => ({ filePath, language: detectLanguage(filePath) }));
  if (maxFiles === undefined || maxFiles <= 0) return all;
  let code = 0;
  return all.filter((file) => !isCodeLanguage(file.language) || ++code <= maxFiles);
}

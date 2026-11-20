import type { LanguageTable, SupportedLanguage } from "./language.js";

export type SupportedSourceFile = {
  filePath: string;
  language: SupportedLanguage;
};

// Every discovered file with its language. `maxFiles` limits the code files;
// the other files are always kept (they are not parsed for declarations).
export function filterSupportedSourceFiles(
  files: string[],
  maxFiles: number | undefined,
  languages: LanguageTable,
  extensions?: ReadonlyMap<string, SupportedLanguage>,
): SupportedSourceFile[] {
  const all: SupportedSourceFile[] = languages.detectAll(files, extensions);
  if (maxFiles === undefined || maxFiles <= 0) return all;
  let code = 0;
  return all.filter((file) => !languages.isCode(file.language) || ++code <= maxFiles);
}

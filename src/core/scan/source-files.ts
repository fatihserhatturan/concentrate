import { detectLanguage } from "./language.js";

export type SupportedSourceFile = {
  filePath: string;
  language: NonNullable<ReturnType<typeof detectLanguage>>;
};

export function filterSupportedSourceFiles(
  files: string[],
  maxFiles: number | undefined,
): SupportedSourceFile[] {
  const supportedFiles = files
    .map((filePath) => ({ filePath, language: detectLanguage(filePath) }))
    .filter((file): file is SupportedSourceFile => file.language !== null);

  return maxFiles !== undefined && maxFiles > 0
    ? supportedFiles.slice(0, maxFiles)
    : supportedFiles;
}

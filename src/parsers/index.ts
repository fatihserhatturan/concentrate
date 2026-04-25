import type { ParsedSourceFile } from "../graph/model.js";
import type { SupportedLanguage } from "../scanner/language.js";
import { parseJavaScriptLikeFile } from "./javascript-like.js";
import { parsePythonFile } from "./python.js";

export async function parseSourceFile(
  rootPath: string,
  filePath: string,
  language: SupportedLanguage,
): Promise<ParsedSourceFile> {
  if (language === "python") {
    return parsePythonFile(rootPath, filePath, language);
  }

  return parseJavaScriptLikeFile(rootPath, filePath, language);
}

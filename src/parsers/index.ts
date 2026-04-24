import type { ParsedSourceFile } from "../graph/model.js";
import type { SupportedLanguage } from "../scanner/language.js";
import { parseJavaScriptLikeFile } from "./javascript-like.js";

export async function parseSourceFile(
  rootPath: string,
  filePath: string,
  language: SupportedLanguage,
): Promise<ParsedSourceFile> {
  return parseJavaScriptLikeFile(rootPath, filePath, language);
}

import { parseJsTsFile, type JsTsFrameworkPlugin } from "./parser.js";
import type { ILanguageParser } from "../../../core/contracts/language-parser.js";

export type { JsTsFrameworkPlugin, JsTsParsedFile, ScriptBlock } from "./parser.js";
export { createCallNodes } from "./calls.js";
export { createFunctionNode } from "./functions.js";

// The JS/TS parser for one language, running `plugins` on every file.
export function createJsTsParser(
  language: "javascript" | "typescript",
  plugins: readonly JsTsFrameworkPlugin[] = [],
): ILanguageParser {
  return {
    language,
    parse: (rootPath, filePath) => parseJsTsFile(rootPath, filePath, language, plugins),
  };
}

// Language-level parsers without framework plugins.
export const javascriptLanguageParser = createJsTsParser("javascript");
export const typescriptLanguageParser = createJsTsParser("typescript");

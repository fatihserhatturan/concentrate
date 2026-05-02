import { parseJsTsLanguageOnly } from "../../../parsers/languages/javascript-like.js";
import type { ILanguageParser } from "../../../core/contracts/language-parser.js";

export const javascriptLanguageParser: ILanguageParser = {
  language: "javascript",
  parse: (rootPath, filePath) => parseJsTsLanguageOnly(rootPath, filePath, "javascript"),
};

export const typescriptLanguageParser: ILanguageParser = {
  language: "typescript",
  parse: (rootPath, filePath) => parseJsTsLanguageOnly(rootPath, filePath, "typescript"),
};

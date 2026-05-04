import { rustParser } from "./parser.js";
import type { ILanguageParser } from "../../../core/contracts/language-parser.js";

export const rustLanguageParser: ILanguageParser = rustParser;
export { resolveRustImport } from "./resolution.js";

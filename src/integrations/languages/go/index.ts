import { goParser } from "./parser.js";
import type { ILanguageParser } from "../../../core/contracts/language-parser.js";

export const goLanguageParser: ILanguageParser = goParser;
export { resolveGoImport } from "./resolution.js";

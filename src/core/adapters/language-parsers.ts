import {
  getLanguageParser,
  registerLanguageParser,
} from "../../parsers/registry.js";
import type { SupportedLanguage } from "../../scanner/language.js";
import type { ILanguageParser } from "../contracts/language-parser.js";
import { javascriptLanguageParser, typescriptLanguageParser } from "../../integrations/languages/js-ts/index.js";
import { pythonLanguageParser } from "../../integrations/languages/python/index.js";
import { goLanguageParser } from "../../integrations/languages/go/index.js";
import { rustLanguageParser } from "../../integrations/languages/rust/index.js";

export function getParserAdapter(language: string): ILanguageParser {
  return getLanguageParser(language as SupportedLanguage);
}

export function registerParserAdapter(parser: ILanguageParser): void {
  registerLanguageParser({
    language: parser.language as SupportedLanguage,
    parse: parser.parse.bind(parser),
  });
}

// All language integration parsers, indexed by language name.
// These are the language-boundary entry points for each supported language.
export const languageParsers: ReadonlyMap<string, ILanguageParser> = new Map([
  ["javascript", javascriptLanguageParser],
  ["typescript", typescriptLanguageParser],
  ["python", pythonLanguageParser],
  ["go", goLanguageParser],
  ["rust", rustLanguageParser],
]);

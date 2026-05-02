import type { ILanguageParser } from "../contracts/language-parser.js";
import { coreIntegrationRegistry } from "../integrations/default-registry.js";

export function getParserAdapter(language: string): ILanguageParser {
  return coreIntegrationRegistry.getLanguageParser(language);
}

export function registerParserAdapter(parser: ILanguageParser): void {
  coreIntegrationRegistry.registerLanguageParser(parser);
}

// Language-boundary parsers, indexed by language name.
export const languageParsers: ReadonlyMap<string, ILanguageParser> = coreIntegrationRegistry.languageParsers;

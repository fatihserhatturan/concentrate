import type { ParsedSourceFile } from "../core/graph/model.js";
import { coreIntegrationRegistry } from "../core/integrations/default-registry.js";
import type { SupportedLanguage } from "../scanner/language.js";
import type { LanguageParser } from "./types.js";

export function registerLanguageParser(parser: LanguageParser): void {
  coreIntegrationRegistry.registerLanguageParser(parser);
}

export function getLanguageParser(language: SupportedLanguage): LanguageParser {
  return coreIntegrationRegistry.getLanguageParser(language) as LanguageParser;
}

export function parseSourceFile(
  rootPath: string,
  filePath: string,
  language: SupportedLanguage,
): Promise<ParsedSourceFile> {
  return getLanguageParser(language).parse(rootPath, filePath);
}

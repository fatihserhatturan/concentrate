import type { ILanguageParser } from "../contracts/language-parser.js";
import type { ILanguageResolver } from "../contracts/language-resolver.js";
import type { ISemanticContributor } from "../contracts/semantic-contributor.js";

export class CoreIntegrationRegistry {
  private readonly scanParsersByLanguage = new Map<string, ILanguageParser>();
  private readonly languageParsersByLanguage = new Map<string, ILanguageParser>();
  private readonly languageResolverList: ILanguageResolver[] = [];
  private readonly semanticContributorList: ISemanticContributor[] = [];

  registerLanguageParser(
    parser: ILanguageParser,
    options: { scan?: boolean; integration?: boolean } = {},
  ): void {
    const scan = options.scan ?? true;
    const integration = options.integration ?? true;

    if (scan) {
      this.scanParsersByLanguage.set(parser.language, parser);
    }
    if (integration) {
      this.languageParsersByLanguage.set(parser.language, parser);
    }
  }

  getLanguageParser(language: string): ILanguageParser {
    const parser = this.scanParsersByLanguage.get(language);
    if (!parser) {
      throw new Error(`No parser registered for language: ${language}`);
    }
    return parser;
  }

  getLanguageIntegration(language: string): ILanguageParser {
    const parser = this.languageParsersByLanguage.get(language) ?? this.scanParsersByLanguage.get(language);
    if (!parser) {
      throw new Error(`No language integration registered for language: ${language}`);
    }
    return parser;
  }

  get languageParsers(): ReadonlyMap<string, ILanguageParser> {
    return this.languageParsersByLanguage;
  }

  registerLanguageResolver(resolver: ILanguageResolver): void {
    this.languageResolverList.push(resolver);
  }

  get languageResolvers(): readonly ILanguageResolver[] {
    return this.languageResolverList;
  }

  registerSemanticContributor(contributor: ISemanticContributor): void {
    this.semanticContributorList.push(contributor);
  }

  get semanticContributors(): readonly ISemanticContributor[] {
    return this.semanticContributorList;
  }
}

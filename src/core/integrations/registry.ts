import type { ILanguageCallResolver, ILanguageInheritanceResolver } from "../contracts/call-resolver.js";
import type { LanguageDescriptor } from "../contracts/language-descriptor.js";
import type { IProjectManifestReader } from "../contracts/project-manifest.js";
import type { ILanguageParser } from "../contracts/language-parser.js";
import type { ILanguageResolver } from "../contracts/language-resolver.js";
import type { ISemanticContributor } from "../contracts/semantic-contributor.js";

export class CoreIntegrationRegistry {
  private readonly languageDescriptors = new Map<string, LanguageDescriptor>();
  private readonly parsersByLanguage = new Map<string, ILanguageParser>();
  private readonly languageResolverList: ILanguageResolver[] = [];
  private readonly semanticContributorList: ISemanticContributor[] = [];
  private readonly callResolverList: ILanguageCallResolver[] = [];
  private readonly inheritanceResolverList: ILanguageInheritanceResolver[] = [];
  private readonly projectManifestReaderList: IProjectManifestReader[] = [];

  // What files a language owns and whether it is code; registering an id again replaces it.
  registerLanguage(descriptor: LanguageDescriptor): void {
    this.languageDescriptors.set(descriptor.id, descriptor);
  }

  get languages(): readonly LanguageDescriptor[] {
    return [...this.languageDescriptors.values()];
  }

  // One parser per language; registering a language again replaces its parser.
  registerLanguageParser(parser: ILanguageParser): void {
    this.parsersByLanguage.set(parser.language, parser);
  }

  getLanguageParser(language: string): ILanguageParser {
    const parser = this.parsersByLanguage.get(language);
    if (!parser) {
      throw new Error(`No parser registered for language: ${language}`);
    }
    return parser;
  }

  get languageParsers(): ReadonlyMap<string, ILanguageParser> {
    return this.parsersByLanguage;
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

  // Per-language call resolution; the first that supports a calling file resolves its calls.
  registerCallResolver(resolver: ILanguageCallResolver): void {
    this.callResolverList.push(resolver);
  }

  get callResolvers(): readonly ILanguageCallResolver[] {
    return this.callResolverList;
  }

  // Per-language EXTENDS / IMPLEMENTS, run in registration order after the default lookup.
  registerInheritanceResolver(resolver: ILanguageInheritanceResolver): void {
    this.inheritanceResolverList.push(resolver);
  }

  get inheritanceResolvers(): readonly ILanguageInheritanceResolver[] {
    return this.inheritanceResolverList;
  }

  // Ecosystem manifests (package.json, pyproject.toml, ...): the packages and config values they declare.
  registerProjectManifestReader(reader: IProjectManifestReader): void {
    this.projectManifestReaderList.push(reader);
  }

  get projectManifestReaders(): readonly IProjectManifestReader[] {
    return this.projectManifestReaderList;
  }
}

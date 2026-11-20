import type { ILanguageCallResolver, ILanguageInheritanceResolver } from "../contracts/call-resolver.js";
import type { LanguageDescriptor } from "../contracts/language-descriptor.js";
import type { IProjectManifestReader } from "../contracts/project-manifest.js";
import type { ILanguageParser } from "../contracts/language-parser.js";
import type { ILanguageResolver } from "../contracts/language-resolver.js";
import type { ISemanticContributor } from "../contracts/semantic-contributor.js";
import { baseGraphSchema, mergeGraphSchema, type GraphSchema, type GraphSchemaExtension } from "../graph/schema.js";

export class CoreIntegrationRegistry {
  private readonly languageDescriptors = new Map<string, LanguageDescriptor>();
  private readonly parsersByLanguage = new Map<string, ILanguageParser>();
  private readonly languageResolverList: ILanguageResolver[] = [];
  private readonly semanticContributorList: ISemanticContributor[] = [];
  private readonly callResolverList: ILanguageCallResolver[] = [];
  private readonly inheritanceResolverList: ILanguageInheritanceResolver[] = [];
  private readonly projectManifestReaderList: IProjectManifestReader[] = [];
  // The contributors in run order; dropped whenever one is registered.
  private orderedContributors: readonly ISemanticContributor[] | null = null;
  private readonly graphSchemaExtensions: GraphSchemaExtension[] = [];
  private mergedGraphSchema: GraphSchema = baseGraphSchema;

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

  // Ids are unique. Contributors run in registration order, except that each
  // runs after the ones it `dependsOn`.
  registerSemanticContributor(contributor: ISemanticContributor): void {
    if (this.semanticContributorList.some((existing) => existing.id === contributor.id)) {
      throw new Error(`Semantic contributor already registered: ${contributor.id}`);
    }
    this.semanticContributorList.push(contributor);
    this.orderedContributors = null;
  }

  // In run order: dependencies first, otherwise registration order. Throws on an unknown dependency or a cycle.
  get semanticContributors(): readonly ISemanticContributor[] {
    this.orderedContributors ??= orderContributors(this.semanticContributorList);
    return this.orderedContributors;
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

  // New graph tables and extra properties on existing ones. Ids are unique, and an
  // extension that conflicts with the schema so far (see mergeGraphSchema) is
  // rejected here, so a bad plugin fails at registration, not at the first write.
  registerGraphSchema(extension: GraphSchemaExtension): void {
    if (this.graphSchemaExtensions.some((existing) => existing.id === extension.id)) {
      throw new Error(`Graph schema extension already registered: ${extension.id}`);
    }
    this.graphSchemaExtensions.push(extension);
    try {
      this.mergedGraphSchema = mergeGraphSchema(baseGraphSchema, this.graphSchemaExtensions);
    } catch (error) {
      this.graphSchemaExtensions.pop();
      throw error;
    }
  }

  // The base schema merged with every registered extension, in registration order.
  get graphSchema(): GraphSchema {
    return this.mergedGraphSchema;
  }
}

// One sorted line per registered integration with its version: what a parse
// cache entry depends on besides the code of this build.
export function describeIntegrations(registry: CoreIntegrationRegistry): string[] {
  const line = (kind: string, id: string, version: string | undefined) => `${kind}:${id}@${version ?? ""}`;
  return [
    ...registry.languages.map((item) => line("language", item.id, item.version)),
    ...[...registry.languageParsers.values()].map((item) => line("parser", item.language, item.version)),
    ...registry.languageResolvers.map((item) => line("resolver", item.id, item.version)),
    ...registry.semanticContributors.map((item) => line("contributor", item.id, item.version)),
    ...registry.callResolvers.map((item) => line("call-resolver", item.id, undefined)),
    ...registry.inheritanceResolvers.map((item) => line("inheritance-resolver", item.id, undefined)),
    ...registry.projectManifestReaders.map((item) => line("manifest-reader", item.id, item.version)),
  ].sort();
}

// Topological order that is stable on registration order: of the contributors
// whose dependencies have run, the earliest registered goes first.
function orderContributors(contributors: readonly ISemanticContributor[]): readonly ISemanticContributor[] {
  if (!contributors.some((contributor) => contributor.dependsOn?.length)) return [...contributors];
  const indexById = new Map(contributors.map((contributor, index) => [contributor.id, index]));
  const remaining = new Map<number, Set<number>>();
  contributors.forEach((contributor, index) => {
    const pending = new Set<number>();
    for (const dependency of contributor.dependsOn ?? []) {
      const dependencyIndex = indexById.get(dependency);
      if (dependencyIndex === undefined) {
        throw new Error(`Semantic contributor ${contributor.id} depends on unknown contributor: ${dependency}`);
      }
      pending.add(dependencyIndex);
    }
    remaining.set(index, pending);
  });

  const ordered: ISemanticContributor[] = [];
  while (remaining.size > 0) {
    let next: number | undefined;
    for (const [index, pending] of remaining) {
      if (pending.size === 0) { next = index; break; }
    }
    if (next === undefined) {
      const cycle = [...remaining.keys()].map((index) => contributors[index]!.id).join(", ");
      throw new Error(`Semantic contributors depend on each other in a cycle: ${cycle}`);
    }
    remaining.delete(next);
    for (const pending of remaining.values()) pending.delete(next);
    ordered.push(contributors[next]!);
  }
  return ordered;
}

// A registry with nothing registered: the start of a registry built from plugins only.
export function createEmptyCoreIntegrationRegistry(): CoreIntegrationRegistry {
  return new CoreIntegrationRegistry();
}

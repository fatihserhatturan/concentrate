import path from "node:path";
import type { DetectedFile, FileConventions, LanguageDescriptor } from "../contracts/language-descriptor.js";

// A language is a string: the `id` of a registered descriptor.
export type SupportedLanguage = string;

/**
 * The languages a scan knows, built from descriptors. Detection precedence:
 * extension overrides (lower case, from concentrate.json), the extension as
 * written, exact and matched file names, the lower-case extension, then the
 * fallback language.
 */
export class LanguageTable {
  private readonly byId = new Map<string, LanguageDescriptor>();
  private readonly byExtension = new Map<string, string>();
  private readonly byFileName = new Map<string, string>();
  private readonly nameMatchers: Array<{ id: string; match: (fileName: string) => boolean }> = [];
  private readonly refiners: Array<(files: DetectedFile[]) => void> = [];
  private readonly fallbackId: string;

  /** Registering a language again replaces its descriptor; for a shared extension or file name the later descriptor wins. */
  constructor(descriptors: readonly LanguageDescriptor[]) {
    let fallback = "unknown";
    for (const descriptor of descriptors) {
      this.byId.set(descriptor.id, descriptor);
      for (const extension of descriptor.extensions ?? []) this.byExtension.set(extension, descriptor.id);
      for (const name of descriptor.fileNames ?? []) this.byFileName.set(name, descriptor.id);
      if (descriptor.matchFileName) this.nameMatchers.push({ id: descriptor.id, match: descriptor.matchFileName });
      if (descriptor.refine) this.refiners.push(descriptor.refine);
      if (descriptor.fallback) fallback = descriptor.id;
    }
    this.fallbackId = fallback;
  }

  /** Every language id, code languages first. */
  get names(): readonly string[] {
    return [...this.codeLanguages, ...[...this.byId.keys()].filter((id) => !this.codeLanguages.has(id))];
  }

  /** The ids of the languages whose files are parsed for declarations, imports and calls. */
  get codeLanguages(): ReadonlySet<string> {
    return new Set([...this.byId.values()].filter((descriptor) => descriptor.code).map((descriptor) => descriptor.id));
  }

  /** The file-name conventions of all languages together: a test, generated or support name of any language counts for every file. */
  get conventions(): FileConventions {
    return combineConventions([...this.byId.values()]);
  }

  has(language: string): boolean {
    return this.byId.has(language);
  }

  isCode(language: string): boolean {
    return this.byId.get(language)?.code === true;
  }

  // `overrides` (extension → language, lower case, from concentrate.json) win over the descriptors.
  detect(filePath: string, overrides?: ReadonlyMap<string, SupportedLanguage>): SupportedLanguage {
    const fileName = path.basename(filePath);
    const extension = path.extname(fileName).toLowerCase();
    return overrides?.get(extension)
      ?? this.byExtension.get(path.extname(fileName))
      ?? this.languageByName(fileName)
      ?? this.byExtension.get(extension)
      ?? this.fallbackId;
  }

  /** Detects every file, then lets the descriptors refine the result across files. */
  detectAll(filePaths: readonly string[], overrides?: ReadonlyMap<string, SupportedLanguage>): DetectedFile[] {
    const files = filePaths.map((filePath) => ({ filePath, language: this.detect(filePath, overrides) }));
    for (const refine of this.refiners) refine(files);
    return files;
  }

  private languageByName(fileName: string): string | undefined {
    const exact = this.byFileName.get(fileName);
    if (exact !== undefined) return exact;
    return this.nameMatchers.find((matcher) => matcher.match(fileName))?.id;
  }
}

const never = () => false;

/** Combines the descriptors' file conventions. With no descriptors nothing is a test, generated or support name, and nothing is ignored. */
export function combineConventions(descriptors: readonly LanguageDescriptor[]): FileConventions {
  const any = (pick: (descriptor: LanguageDescriptor) => ((fileName: string) => boolean) | undefined) => {
    const tests = descriptors.map(pick).filter((test): test is (fileName: string) => boolean => test !== undefined);
    return tests.length === 0 ? never : (fileName: string) => tests.some((test) => test(fileName));
  };
  const scoped = descriptors.map((descriptor) => descriptor.ignoredInDirectory).filter((hook) => hook !== undefined);
  return {
    testFile: any((descriptor) => descriptor.testFile),
    generatedFile: any((descriptor) => descriptor.generatedFile),
    supportFile: any((descriptor) => descriptor.supportFile),
    lockfiles: new Set(descriptors.flatMap((descriptor) => descriptor.lockfiles ?? [])),
    claimedFileNames: new Set(descriptors.flatMap((descriptor) => descriptor.fileNames ?? [])),
    ignoredPatterns: descriptors.flatMap((descriptor) => descriptor.ignoredPatterns ?? []),
    ignoredInDirectory: (entryNames) => scoped.flatMap((hook) => hook(entryNames)),
  };
}

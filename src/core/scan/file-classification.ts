import path from "node:path";

export type FileSourceType = "production" | "test" | "fixture" | "support" | "generated" | "docs";

export type FileClassification = {
  sourceType: FileSourceType;
  isTest: boolean;
  isFixture: boolean;
  isSupport: boolean;
  isGenerated: boolean;
  isDocs: boolean;
};

export type FileClassificationCounts = Record<FileSourceType, number>;

// Lockfiles are written by package managers.
export const lockfiles: ReadonlySet<string> = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock", "go.sum", "Cargo.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "composer.lock", "Gemfile.lock"]);

// `code` is false for the files no language parser reads (styles, JSON,
// Markdown, assets, …): only those can be `docs`, so example code under
// `docs/` stays production code.
export function classifyFile(relativePath: string, generatedContent = false, code = true): FileClassification {
  const normalizedPath = relativePath.split(path.sep).join("/");
  const segments = normalizedPath.split("/");
  const fileName = segments.at(-1) ?? normalizedPath;

  const isGenerated = generatedContent || hasSegment(segments, [
    "generated",
    "__generated__",
    "codegen",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "coverage",
  ]) || /(?:^|[.-])(generated|gen)\.[cm]?[jt]sx?$/u.test(fileName) || lockfiles.has(fileName);

  const isFixture = hasSegment(segments, [
    "fixture",
    "fixtures",
    "__fixtures__",
    "sample",
    "samples",
    "testdata",
  ]);

  const isTest = hasSegment(segments, [
    "test",
    "tests",
    "__tests__",
    "spec",
    "specs",
  ]) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(fileName) || fileName.endsWith("_test.go") || /^tests\.rs$|_tests?\.rs$/u.test(fileName);

  const isSupport = hasSegment(segments, [
    "mock",
    "mocks",
    "__mocks__",
    "stub",
    "stubs",
    "__stubs__",
    "support",
  ]) || /(?:^|[.-])(mock|mocks|stub|stubs|setup|setupTests)\.[cm]?[jt]sx?$/u.test(fileName);

  const isDocs = !code && (
    /\.(?:md|mdx|markdown|rst|adoc|txt)$/iu.test(fileName)
    || /^(?:LICEN[CS]E|COPYING|NOTICE|AUTHORS|CONTRIBUTORS|CHANGELOG|CHANGES|HISTORY|README|CODE_OF_CONDUCT|CONTRIBUTING|SECURITY)(?:[.-].*)?$/iu.test(fileName)
    || hasSegment(segments, ["docs", "doc"])
  );

  return {
    sourceType: primarySourceType({ isGenerated, isFixture, isTest, isSupport, isDocs }),
    isTest,
    isFixture,
    isSupport,
    isGenerated,
    isDocs,
  };
}

export function createFileClassificationCounts(): FileClassificationCounts {
  return {
    production: 0,
    test: 0,
    fixture: 0,
    support: 0,
    generated: 0,
    docs: 0,
  };
}

function primarySourceType(input: Omit<FileClassification, "sourceType">): FileSourceType {
  if (input.isGenerated) return "generated";
  if (input.isFixture) return "fixture";
  if (input.isTest) return "test";
  if (input.isSupport) return "support";
  if (input.isDocs) return "docs";
  return "production";
}

function hasSegment(segments: string[], names: string[]): boolean {
  const normalizedNames = new Set(names);
  return segments.some((segment) => normalizedNames.has(segment));
}

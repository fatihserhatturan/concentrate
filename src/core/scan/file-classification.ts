import path from "node:path";

export type FileSourceType = "production" | "test" | "fixture" | "support" | "generated";

export type FileClassification = {
  sourceType: FileSourceType;
  isTest: boolean;
  isFixture: boolean;
  isSupport: boolean;
  isGenerated: boolean;
};

export type FileClassificationCounts = Record<FileSourceType, number>;

export function classifyFile(relativePath: string): FileClassification {
  const normalizedPath = relativePath.split(path.sep).join("/");
  const segments = normalizedPath.split("/");
  const fileName = segments.at(-1) ?? normalizedPath;

  const isGenerated = hasSegment(segments, [
    "generated",
    "__generated__",
    "codegen",
    ".next",
    ".nuxt",
    "dist",
    "build",
    "coverage",
  ]) || /(?:^|[.-])(generated|gen)\.[cm]?[jt]sx?$/u.test(fileName);

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
  ]) || /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(fileName);

  const isSupport = hasSegment(segments, [
    "mock",
    "mocks",
    "__mocks__",
    "stub",
    "stubs",
    "__stubs__",
    "support",
  ]) || /(?:^|[.-])(mock|mocks|stub|stubs|setup|setupTests)\.[cm]?[jt]sx?$/u.test(fileName);

  return {
    sourceType: primarySourceType({ isGenerated, isFixture, isTest, isSupport }),
    isTest,
    isFixture,
    isSupport,
    isGenerated,
  };
}

export function createFileClassificationCounts(): FileClassificationCounts {
  return {
    production: 0,
    test: 0,
    fixture: 0,
    support: 0,
    generated: 0,
  };
}

function primarySourceType(input: Omit<FileClassification, "sourceType">): FileSourceType {
  if (input.isGenerated) return "generated";
  if (input.isFixture) return "fixture";
  if (input.isTest) return "test";
  if (input.isSupport) return "support";
  return "production";
}

function hasSegment(segments: string[], names: string[]): boolean {
  const normalizedNames = new Set(names);
  return segments.some((segment) => normalizedNames.has(segment));
}

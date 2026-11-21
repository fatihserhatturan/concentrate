import path from "node:path";
import type { FileConventions } from "../contracts/language-descriptor.js";

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

// `code` is false for the files no language parser reads (styles, JSON,
// Markdown, assets, …): only those can be `docs`, so example code under
// `docs/` stays production code.
// `conventions` carries the languages' file-name rules (test, generated, support, lockfiles).
export function classifyFile(relativePath: string, conventions: FileConventions, generatedContent = false, code = true, testContent = false): FileClassification {
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
  ]) || conventions.generatedFile(fileName) || conventions.lockfiles.has(fileName);

  // Below a JVM source root (`src/main/java`, `src/test/kotlin`, …) directories
  // are package names (`org.springframework.samples.petclinic`), not layout
  // folders, so the name heuristics for fixtures, mocks and support skip them.
  const layoutSegments = segments.slice(0, jvmSourceRootEnd(segments));

  const isFixture = hasSegment(layoutSegments, [
    "fixture",
    "fixtures",
    "__fixtures__",
    "sample",
    "samples",
    "testdata",
  ]);

  const isTest = hasSegment(layoutSegments, [
    "test",
    "tests",
    "__tests__",
    "spec",
    "specs",
  ]) || conventions.testFile(fileName)
    || testContent;

  const isSupport = hasSegment(layoutSegments, [
    "mock",
    "mocks",
    "__mocks__",
    "stub",
    "stubs",
    "__stubs__",
    "support",
  ]) || conventions.supportFile(fileName);

  const isDocs = !code && (
    (/\.(?:md|mdx|markdown|rst|adoc|txt)$/iu.test(fileName) && !conventions.claimedFileNames.has(fileName))
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

// Index just past a `src/<set>/<jvm language>` root, or the full length when the path has none.
function jvmSourceRootEnd(segments: string[]): number {
  for (let index = 0; index + 2 < segments.length - 1; index += 1) {
    if (segments[index] === "src" && JVM_LANGUAGE_DIRS.has(segments[index + 2]!)) return index + 3;
  }
  return segments.length;
}

const JVM_LANGUAGE_DIRS = new Set(["java", "kotlin", "scala", "groovy"]);

function hasSegment(segments: string[], names: string[]): boolean {
  const normalizedNames = new Set(names);
  return segments.some((segment) => normalizedNames.has(segment));
}

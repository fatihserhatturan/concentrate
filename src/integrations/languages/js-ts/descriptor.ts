import type { LanguageDescriptor } from "../../../core/contracts/language-descriptor.js";
import { combineConventions } from "../../../core/scan/language.js";

export const isJsTsTestFile = (fileName: string): boolean => /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(fileName);
export const isJsTsGeneratedFile = (fileName: string): boolean => /(?:^|[.-])(generated|gen)\.[cm]?[jt]sx?$/u.test(fileName);
export const isJsTsSupportFile = (fileName: string): boolean => /(?:^|[.-])(mock|mocks|stub|stubs|setup|setupTests)\.[cm]?[jt]sx?$/u.test(fileName);

// The file conventions of the JavaScript ecosystem, carried by its first descriptor.
const jsTsFileConventions: Partial<LanguageDescriptor> = {
  testFile: isJsTsTestFile,
  generatedFile: isJsTsGeneratedFile,
  supportFile: isJsTsSupportFile,
  lockfiles: ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"],
  ignoredPatterns: ["node_modules", ".next", ".turbo", "*.min.js"],
};

// JavaScript, TypeScript and the markup formats whose scripts they parse.
export const jsTsLanguages: readonly LanguageDescriptor[] = [
  { id: "javascript", displayName: "JavaScript", code: true, extensions: [".js", ".jsx", ".mjs", ".cjs"], ...jsTsFileConventions },
  { id: "typescript", displayName: "TypeScript", code: true, extensions: [".ts", ".tsx", ".mts", ".cts"] },
  { id: "html", code: true, extensions: [".html", ".htm"] },
  { id: "vue", code: true, extensions: [".vue"] },
  { id: "svelte", code: true, extensions: [".svelte"] },
  { id: "astro", code: true, extensions: [".astro"] },
];

/** The JavaScript and TypeScript file conventions alone, for classifying a file while it is parsed. */
export const jsTsConventions = combineConventions(jsTsLanguages);

import { createLanguageFileMatcher } from "../../core/scan/language.js";
import { cppLanguages } from "./cpp/descriptor.js";
import { goLanguages } from "./go/descriptor.js";
import { javaLanguages } from "./java/descriptor.js";
import { jsTsLanguages } from "./js-ts/descriptor.js";
import { pythonLanguages } from "./python/descriptor.js";
import { rustLanguages } from "./rust/descriptor.js";

// Each test is built from the language's descriptors, so the extensions live in one place.

// The JS/TS descriptors include the markup languages (.html/.htm/.vue/.svelte/.astro):
// markup files import with JS/TS rules too (`@/components/Card.vue`).
const jsTsMatcher = createLanguageFileMatcher(...jsTsLanguages);
const goMatcher = createLanguageFileMatcher(...goLanguages);
const pythonMatcher = createLanguageFileMatcher(...pythonLanguages);
const rustMatcher = createLanguageFileMatcher(...rustLanguages);
const cppMatcher = createLanguageFileMatcher(...cppLanguages);
const javaMatcher = createLanguageFileMatcher(...javaLanguages);

export function isJsTsFile(fileId: string): boolean {
  return jsTsMatcher(fileId);
}

export function isGoFile(fileId: string): boolean {
  return goMatcher(fileId);
}

export function isPythonFile(fileId: string): boolean {
  return pythonMatcher(fileId);
}

export function isRustFile(fileId: string): boolean {
  return rustMatcher(fileId);
}

export function isCppFile(fileId: string): boolean {
  return cppMatcher(fileId);
}

export function isJavaFile(fileId: string): boolean {
  return javaMatcher(fileId);
}

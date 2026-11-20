import type { LanguageDescriptor } from "../../../core/contracts/language-descriptor.js";

export const rustLanguages: readonly LanguageDescriptor[] = [
  { id: "rust", displayName: "Rust", code: true, extensions: [".rs"], testFile: (fileName) => /^tests\.rs$|_tests?\.rs$/u.test(fileName), lockfiles: ["Cargo.lock"] },
];

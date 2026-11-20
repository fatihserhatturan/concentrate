import type { LanguageDescriptor } from "../../../core/contracts/language-descriptor.js";

export const goLanguages: readonly LanguageDescriptor[] = [
  {
    id: "go",
    code: true,
    extensions: [".go"],
    testFile: (fileName) => fileName.endsWith("_test.go"),
    lockfiles: ["go.sum"],
    // A Go module's `vendor/` holds copies of its dependencies.
    ignoredInDirectory: (entryNames) => (entryNames.includes("go.mod") && entryNames.includes("vendor") ? ["/vendor/"] : []),
  },
];

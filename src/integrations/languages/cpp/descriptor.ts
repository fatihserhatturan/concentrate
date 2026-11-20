import type { LanguageDescriptor } from "../../../core/contracts/language-descriptor.js";

// A header is C unless the project has C++ sources: then its headers are read as C++.
function readHeadersAsCpp(files: { filePath: string; language: string }[]): void {
  if (!files.some((file) => file.language === "cpp")) return;
  for (const file of files) if (file.language === "c" && file.filePath.endsWith(".h")) file.language = "cpp";
}

// `foo_test.cc`, `foo_unittest.cpp`, `test_foo.c`, `FooTest.cpp`.
const isCppTestFile = (fileName: string): boolean => /(?:_(?:unit)?tests?|[a-z]Tests?)\.(?:c|cc|cpp|cxx)$|^test_.+\.(?:c|cc|cpp|cxx)$/u.test(fileName);

export const cppLanguages: readonly LanguageDescriptor[] = [
  { id: "c", displayName: "C", code: true, extensions: [".c", ".h"], refine: readHeadersAsCpp, testFile: isCppTestFile },
  { id: "cpp", displayName: "C++", code: true, extensions: [".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".ipp", ".inl"] },
];

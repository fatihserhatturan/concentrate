import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LanguageDescriptor } from "../src/core/contracts/language-descriptor.js";
import { createLanguageFileMatcher, fileMatchesLanguage } from "../src/core/scan/language.js";
import { isCSharpFile, isCppFile, isGoFile, isJsTsFile, isPythonFile, isRustFile } from "../src/integrations/languages/file-kind.js";

// The hand-written lists file-kind.ts used before it read the descriptors.
const legacy: Record<string, { test: (fileId: string) => boolean; extensions: string[] }> = {
  jsTs: { test: isJsTsFile, extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".html", ".htm", ".vue", ".svelte", ".astro"] },
  go: { test: isGoFile, extensions: [".go"] },
  python: { test: isPythonFile, extensions: [".py"] },
  rust: { test: isRustFile, extensions: [".rs"] },
  cpp: { test: isCppFile, extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp", ".hh", ".hxx", ".ipp", ".inl"] },
};

const everyExtension = [...new Set(Object.values(legacy).flatMap((entry) => entry.extensions)), ".d.ts", ".json", ".md", ".txt", ".css", ".proto", ".tsx.map", ".pyi", ".rlib", ".cu"];

describe("file-kind through language descriptors", () => {
  for (const [name, { test, extensions }] of Object.entries(legacy)) {
    it(`${name} accepts exactly the extensions of the old list`, () => {
      for (const extension of extensions) {
        assert.ok(test(`file:src/a${extension}`), `${extension} should be accepted`);
        assert.ok(test(`file:a${extension}`), `${extension} at the root should be accepted`);
      }
      const accepted = everyExtension.filter((extension) => test(`file:src/a${extension}`)).sort();
      const expected = extensions.filter((extension) => everyExtension.includes(extension)).sort();
      // `.d.ts` is a `.ts` file by extname: every list that took `.ts` takes it.
      if (extensions.includes(".ts")) expected.push(".d.ts");
      assert.deepEqual(accepted, expected.sort());
    });
  }

  it("csharp accepts .cs and .csx only", () => {
    for (const extension of [".cs", ".csx"]) assert.ok(isCSharpFile(`file:src/a${extension}`), extension);
    for (const extension of [".csproj", ".c", ".css", ".java", ".cshtml"]) assert.equal(isCSharpFile(`file:src/a${extension}`), false, extension);
  });

  it("matches the extension of the last path segment only", () => {
    assert.equal(isJsTsFile("file:src/a.ts/readme"), false);
    assert.equal(isJsTsFile("file:src/.ts"), false);
    assert.equal(isGoFile("file:vendor.go/main.rs"), false);
    assert.equal(isRustFile("file:a.d.rs"), true);
    assert.equal(isJsTsFile("file:a.test.mts"), true);
    assert.equal(isJsTsFile("file:types/a.d.cts"), true);
  });

  it("treats .h as C-family, whatever refinement later makes of it", () => {
    assert.equal(isCppFile("file:include/a.h"), true);
    assert.equal(isCppFile("file:include/a.H"), true);
    assert.equal(isJsTsFile("file:include/a.h"), false);
  });

  it("applies the scan's case rule: the extension as written, then lower case", () => {
    assert.equal(isGoFile("file:Main.GO"), true);
    assert.equal(isPythonFile("file:Script.PY"), true);
  });
});

describe("language file matcher", () => {
  const custom: LanguageDescriptor = {
    id: "custom",
    code: false,
    extensions: [".cst", ".Cased"],
    fileNames: ["Customfile"],
    matchFileName: (name) => name.startsWith("Customfile."),
  };

  it("matches extensions, file names and name matchers", () => {
    const matches = createLanguageFileMatcher(custom);
    assert.equal(matches("file:a/b.cst"), true);
    assert.equal(matches("file:a/B.CST"), true);
    assert.equal(matches("file:a/b.Cased"), true);
    assert.equal(matches("file:Customfile"), true);
    assert.equal(matches("file:sub/Customfile.dev"), true);
    assert.equal(matches("file:sub/other.txt"), false);
  });

  it("matches with no descriptors never and across several descriptors", () => {
    assert.equal(createLanguageFileMatcher()("file:a.ts"), false);
    assert.equal(fileMatchesLanguage([custom], "file:x.cst"), true);
    assert.equal(fileMatchesLanguage([custom], "file:x.ts"), false);
  });
});

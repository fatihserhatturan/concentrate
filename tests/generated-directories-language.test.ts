import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { LanguageDescriptor } from "../src/core/contracts/language-descriptor.js";
import { classifyFile } from "../src/core/scan/file-classification.js";
import { combineConventions } from "../src/core/scan/language.js";

const descriptors: LanguageDescriptor[] = [
  { id: "csharp", code: true, extensions: [".cs"], generatedDirectories: ["obj"] },
  { id: "python", code: true, extensions: [".py"] },
  { id: "typescript", code: true, extensions: [".ts"] },
];
const conventions = combineConventions(descriptors);
const sourceType = (file: string, language: string | undefined) => classifyFile(file, conventions, false, true, false, language).sourceType;

describe("generatedDirectories is scoped to the declaring language", () => {
  it("marks a .cs file under obj/ generated and leaves Python and TypeScript files there production", () => {
    assert.equal(sourceType("lib/obj/a.cs", "csharp"), "generated");
    assert.equal(sourceType("src/obj/model.py", "python"), "production");
    assert.equal(sourceType("src/obj/model.ts", "typescript"), "production");
  });

  it("does not apply a language's directories when the language is unknown", () => {
    assert.equal(sourceType("lib/obj/a.cs", undefined), "production");
  });
});

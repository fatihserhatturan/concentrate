import type { LanguageDescriptor } from "../../../core/contracts/language-descriptor.js";
import { combineConventions } from "../../../core/scan/language.js";

export const isPythonTestFile = (fileName: string): boolean => /^(?:test_.*|.*_test|conftest|tests)\.py$/u.test(fileName);

export const pythonLanguages: readonly LanguageDescriptor[] = [
  { id: "python", displayName: "Python", code: true, extensions: [".py"], testFile: isPythonTestFile, lockfiles: ["poetry.lock", "Pipfile.lock", "uv.lock"] },
];

/** The Python file conventions alone, for classifying a file while it is parsed. */
export const pythonConventions = combineConventions(pythonLanguages);

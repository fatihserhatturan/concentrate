import { coreIntegrationRegistry } from "../../src/composition/default-registry.js";
import type { ILanguageParser } from "../../src/core/contracts/language-parser.js";

// No code language fails a file on a syntax error any more (each keeps a
// partial graph and warns), so tests that need a failed file make the Python
// parser throw for files named `bad*.py` or `broken*.py`. Returns the restore function.
export function failPythonParsingOfBrokenFiles(): () => void {
  const real = coreIntegrationRegistry.getLanguageParser("python");
  const failing: ILanguageParser = {
    language: "python",
    parse: (rootPath, filePath) => (/(?:bad|broken)[^/]*\.py$/u.test(filePath) ? Promise.reject(new Error("Syntax error")) : real.parse(rootPath, filePath)),
  };
  coreIntegrationRegistry.registerLanguageParser(failing);
  return () => coreIntegrationRegistry.registerLanguageParser(real);
}

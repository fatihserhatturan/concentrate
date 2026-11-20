import type { IUnusedExportRules } from "../../../core/contracts/unused-rules.js";
import { isPythonFile } from "../file-kind.js";

// Python files that tools run or load by name, not by import.
const ENTRY_FILE = /(?:^|\/)(?:__main__|setup|manage|wsgi|asgi|conftest)\.py$/u;

export const pythonUnusedRules: IUnusedExportRules = {
  id: "python",
  languages: ["python"],
  supports: isPythonFile,
  skipReasons: ["pythonEntry"],
  // `from m import *` takes every public name of `m` (or its `__all__`).
  wildcardImportUsesWholeFile: true,
  entryReason: (declaration) => (ENTRY_FILE.test(declaration.file) ? "pythonEntry" : null),
  note: "Python: module-level names that are not private (or are listed in `__all__`); `from m import *` marks the whole module as used, and `__main__.py`, `setup.py`, `manage.py`, `wsgi.py`, `asgi.py` and `conftest.py` are skipped.",
};

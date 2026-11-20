import type { IUnusedExportRules } from "../../../core/contracts/unused-rules.js";
import { isCppFile } from "../file-kind.js";
import { addIdentifierCounts, type IdentifierCounts, mentionedOutside } from "../unused-index.js";

const HEADER = /\.(?:h|hpp|hh|hxx|ipp|inl)$/u;

// C and C++: `foo.h` and `foo.cpp` are one unit (a header's names are used by
// its source). A function counts only where it is written in a source file:
// a prototype in a header is not a use.
export const cppUnusedRules: IUnusedExportRules = {
  id: "cpp",
  languages: ["c", "cpp"],
  supports: isCppFile,
  unitOf: (file) => file.replace(/\.[^./]+$/u, ""),
  isPublicApi: (declaration) => !declaration.testKind,
  async createSession(context) {
    const all: IdentifierCounts = new Map();
    const sources: IdentifierCounts = new Map();
    await context.forEachSource(isCppFile, (file, text) => {
      const unit = context.unitOf(file);
      addIdentifierCounts(all, text, unit);
      if (!HEADER.test(file)) addIdentifierCounts(sources, text, unit);
    });
    return {
      isMentionedElsewhere: (declaration) => mentionedOutside(declaration.kind === "function" ? sources : all, declaration.name, context.unitOf(declaration.file)),
    };
  },
  note: "C and C++: a non-static function, class, struct or enum counts as used when a call from another unit (foo.h with foo.cpp is one unit) reaches its definition or another unit mentions its name (for a function, in a source file: a prototype in a header is no use); static and anonymous-namespace functions are checked as deadFunctions only; macros and prototypes are not judged, and uses through function pointers, macros or code outside the repository are not seen.",
};

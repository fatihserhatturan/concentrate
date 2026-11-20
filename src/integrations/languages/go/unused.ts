import path from "node:path";
import type { IUnusedExportRules } from "../../../core/contracts/unused-rules.js";
import { isGoFile } from "../file-kind.js";
import { addIdentifierCounts, type IdentifierCounts, mentionedOutside } from "../unused-index.js";

// Go: an export (capitalized name) is used when another package calls it or
// mentions its name; main packages and init run without a caller.
export const goUnusedRules: IUnusedExportRules = {
  id: "go",
  languages: ["go"],
  supports: isGoFile,
  skipReasons: ["goMain"],
  unitOf: (file) => path.posix.dirname(file),
  entryReason: (declaration, info) => (info.packageName === "main" || declaration.name === "init" ? "goMain" : null),
  async createSession(context) {
    // Names the graph has no edges for (types, variables, functions used as values).
    const mentions: IdentifierCounts = new Map();
    await context.forEachSource(isGoFile, (file, text) => addIdentifierCounts(mentions, text, context.unitOf(file)));
    return {
      isMentionedElsewhere: (declaration) => mentionedOutside(mentions, declaration.name, context.unitOf(declaration.file)),
      // A Go function is visible in every file of its package.
      deadFunctionMentions: (declaration) =>
        declaration.name === "init" || declaration.name === "main" ? Number.POSITIVE_INFINITY : (mentions.get(declaration.name)?.get(context.unitOf(declaration.file)) ?? 0),
    };
  },
  note: "Go: an export (capitalized name) counts as used when another package calls it or mentions its name; main packages and init are skipped, and deadFunctions look for mentions in the whole package.",
};

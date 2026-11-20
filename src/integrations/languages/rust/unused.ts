import type { IUnusedExportRules } from "../../../core/contracts/unused-rules.js";
import { isRustFile } from "../file-kind.js";
import { addIdentifierCounts, type IdentifierCounts, mentionedOutside } from "../unused-index.js";

// A binary crate (main.rs, src/bin, examples, tests, benches) has no dependents.
function isBinaryCrate(crateRoot: string | null | undefined): boolean {
  return crateRoot !== null && crateRoot !== undefined
    && /(^|\/)(main\.rs|build\.rs)$|(^|\/)(src\/bin|examples|tests|benches)\//u.test(crateRoot);
}

// Rust: only `pub` items leave the crate; one is used when another crate
// calls it or mentions its name.
export const rustUnusedRules: IUnusedExportRules = {
  id: "rust",
  languages: ["rust"],
  supports: isRustFile,
  skipReasons: ["rustBinary"],
  unitOf: (file, info) => info?.rustCrate ?? file,
  // Test code is no API.
  isPublicApi: (declaration) => declaration.visibility === "pub" && !declaration.testKind,
  binaryReason: (_declaration, info) => (isBinaryCrate(info.rustCrate) ? "rustBinary" : null),
  async createSession(context) {
    // Identifier counts per crate, for items the graph has no edges for (types, consts, traits, enums).
    const mentions: IdentifierCounts = new Map();
    await context.forEachSource(isRustFile, (file, text) => addIdentifierCounts(mentions, text, context.unitOf(file)));
    return { isMentionedElsewhere: (declaration) => mentionedOutside(mentions, declaration.name, context.unitOf(declaration.file)) };
  },
  note: "Rust: only `pub` items count; one counts as used when another crate calls it or mentions its name; binary crates (main.rs, src/bin, examples, tests, benches) are skipped, and library items consumed outside the repository are not seen.",
};

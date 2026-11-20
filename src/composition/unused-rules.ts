import type { IUnusedExportRules } from "../core/contracts/unused-rules.js";
import { cppUnusedRules } from "../integrations/languages/cpp/unused.js";
import { goUnusedRules } from "../integrations/languages/go/unused.js";
import { jsTsUnusedRules } from "../integrations/languages/js-ts/unused.js";
import { pythonUnusedRules } from "../integrations/languages/python/unused.js";
import { rustUnusedRules } from "../integrations/languages/rust/unused.js";

/** The unused-exports rules of every language the tool knows, in note order. */
export const defaultUnusedExportRules: readonly IUnusedExportRules[] = [jsTsUnusedRules, goUnusedRules, rustUnusedRules, pythonUnusedRules, cppUnusedRules];

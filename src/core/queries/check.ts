import type { ImportCycle, ImportCyclesResult } from "./cycles.js";

// Exit policy of the CI checks (`concentrate cycles` / `unused`): how many
// findings count, whether they exceed what the project allows, and how many
// are listed.

/** Most findings a check lists; the rest are only counted. */
export const MAX_LISTED_FINDINGS = 200;

export type CheckVerdict = { count: number; exceeded: boolean };

/** `exceeded` when `count` is more than the `max` findings allowed (default 0). */
export function checkVerdict(count: number, max = 0): CheckVerdict {
  return { count, exceeded: count > max };
}

export type CyclesCheck = CheckVerdict & {
  scope: ImportCyclesResult["scope"];
  /** The counted cycles, capped at the listing limit. */
  listed: ImportCycle[];
};

/**
 * Applies the cycle policy: type-only cycles (file scope) are not counted
 * unless `includeTypeOnly`; package cycles always count.
 */
export function checkCycles(
  result: ImportCyclesResult,
  options: { includeTypeOnly?: boolean; max?: number; limit?: number } = {},
): CyclesCheck {
  const everything = options.includeTypeOnly || result.scope === "package";
  const counted = everything ? result.cycles : result.cycles.filter((cycle) => !cycle.typeOnly);
  return {
    scope: result.scope,
    listed: counted.slice(0, options.limit ?? MAX_LISTED_FINDINGS),
    ...checkVerdict(counted.length, options.max),
  };
}

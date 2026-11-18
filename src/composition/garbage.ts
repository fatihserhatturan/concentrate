import v8 from "node:v8";
import { runInNewContext } from "node:vm";

// A full garbage collection between the steps of a scan, once the heap has
// grown by STEP_BYTES since the last one. V8 lets the old generation grow to
// about twice what is live before it collects: on a large repository the live
// graph is about 1 GB while each resolver and contributor leaves a few hundred
// MB of indexes behind, so the heap reached 2.4 GB, and the process keeps the
// pages it grew into. Collecting at the step boundaries, where those indexes
// have just become garbage, costs about 0.1 s per collection there; a small
// repository never reaches STEP_BYTES and never pays it.

const STEP_BYTES = 256 * 1024 * 1024;

let collect: (() => void) | null | undefined;
let heapAfterCollection = 0;

// `gc()` without `--expose-gc` on the command line: the flag set at run time
// gives a new context the function; it is turned off again right after.
function exposeGc(): (() => void) | null {
  const global = (globalThis as { gc?: unknown }).gc;
  if (typeof global === "function") return global as () => void;
  try {
    v8.setFlagsFromString("--expose-gc");
    const gc: unknown = runInNewContext("gc");
    v8.setFlagsFromString("--no-expose-gc");
    return typeof gc === "function" ? (gc as () => void) : null;
  } catch {
    return null;
  }
}

export function collectGarbageAfterGrowth(): void {
  const used = v8.getHeapStatistics().used_heap_size;
  // V8 collected on its own since.
  if (used < heapAfterCollection) heapAfterCollection = used;
  if (used - heapAfterCollection < STEP_BYTES) return;
  collect ??= exposeGc();
  if (!collect) return;
  collect();
  heapAfterCollection = v8.getHeapStatistics().used_heap_size;
}

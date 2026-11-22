// Preloaded with `node --import ./scripts/scan-probe.mjs dist/index.js ...` by
// scripts/bench-release.ts: on exit, writes the process's peak resident set
// size to the file named by CONCENTRATE_PROBE_OUT, so the benchmark can read a
// child CLI's memory without an outside tool.
//
// The scan forks a syntax-check helper that inherits both this preload (via
// execArgv) and the environment. The helper exits after the CLI and used to
// overwrite the CLI's reading with its own (~60 MB). Only the process that
// loaded the probe first, the CLI itself, reports; its peak matches the
// `maximum resident set size` of `/usr/bin/time -l`, which also reports the
// largest single process rather than a sum.
import { writeFileSync } from "node:fs";

const output = process.env.CONCENTRATE_PROBE_OUT;
if (output && process.env.CONCENTRATE_PROBE_OWNER === undefined) {
  process.env.CONCENTRATE_PROBE_OWNER = String(process.pid);
  process.on("exit", () => {
    // maxRSS is in kilobytes.
    writeFileSync(output, JSON.stringify({ maxRssKb: process.resourceUsage().maxRSS }));
  });
}

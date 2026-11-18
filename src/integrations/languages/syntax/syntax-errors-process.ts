import { syntaxErrorLinesHere, type SyntaxCheckRequest, type SyntaxCheckResponse } from "./syntax-errors.js";

// Helper process of syntax-errors.ts, started with `--liftoff-only`: checks
// sources whose grammar TurboFan needs gigabytes to compile.

process.on("message", async ({ id, grammar, source, limit }: SyntaxCheckRequest) => {
  let response: SyntaxCheckResponse;
  try {
    response = { id, ok: true, lines: await syntaxErrorLinesHere(grammar, source, limit) };
  } catch (error) {
    response = { id, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
  process.send!(response);
});

// The scan's process ended or closed the channel.
process.on("disconnect", () => process.exit(0));

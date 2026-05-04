import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isKuzuLockError, withKuzuRetry } from "../src/adapters/kuzu/kuzu-retry.js";

describe("Kuzu retry helpers", () => {
  it("recognizes transient Kuzu lock errors", () => {
    assert.equal(isKuzuLockError(new Error("IO exception: Could not set lock on file : graph.kuzu")), true);
    assert.equal(isKuzuLockError(new Error("Syntax error near MATCH")), false);
  });

  it("retries lock errors with backoff and returns the successful result", async () => {
    let attempts = 0;
    const result = await withKuzuRetry(() => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("Could not set lock on file");
      }
      return "ok";
    }, {
      retries: 3,
      initialDelayMs: 1,
      maxDelayMs: 1,
    });

    assert.equal(result, "ok");
    assert.equal(attempts, 3);
  });

  it("does not retry non-lock errors", async () => {
    let attempts = 0;
    await assert.rejects(
      () => withKuzuRetry(() => {
        attempts += 1;
        throw new Error("Syntax error");
      }, {
        retries: 3,
        initialDelayMs: 1,
        maxDelayMs: 1,
      }),
      /Syntax error/,
    );
    assert.equal(attempts, 1);
  });
});

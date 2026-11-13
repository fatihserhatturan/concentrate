import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { scanIntoStore } from "../src/adapters/cli/scan.js";
import { callPaths, questionTerms, rankSymbols } from "../src/adapters/mcp/agent-tools/explore.js";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { provenanceOf } from "../src/adapters/store/provenance.js";
import { SCHEMA_VERSION } from "../src/adapters/store/schema.js";
import { openGraphStore } from "../src/composition/graph-store.js";

async function scan(projectPath: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-explore-"));
  const database = path.join(root, "graph");
  await scanIntoStore(projectPath, {
    database,
    continueOnError: false,
    include: [],
    exclude: [],
    retryLock: true,
    cacheDir: path.join(root, "cache"),
    manifest: path.join(root, "scan-manifest.json"),
  });
  return openGraphStore(database);
}

const FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "explore-app", dependencies: { express: "4.0.0" } }),
  "src/orders.ts": [
    "export function chargeCard(orderId: string) {",
    "  return `charged ${orderId}`;",
    "}",
    "export function placeOrder(orderId: string) {",
    "  return chargeCard(orderId);",
    "}",
    "",
  ].join("\n"),
  "src/users.ts": "export function listUsers() { return []; }\n",
  "src/app.ts": [
    "import express from 'express';",
    "import { placeOrder } from './orders';",
    "const app = express();",
    "app.post('/orders', (req, res) => res.json(placeOrder(req.body.id)));",
    "app.listen(3000);",
    "",
  ].join("\n"),
};

const call = async (store: Awaited<ReturnType<typeof scan>>, name: string, args: Record<string, unknown>) =>
  (await callMcpTool(store, name, args)).structuredContent as any;

describe("explore", () => {
  it("answers a question with source, call paths and impact", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-explore-project-"));
    for (const [file, text] of Object.entries(FILES)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    const store = await scan(root);
    try {
      const result = await call(store, "explore", { question: "How does placeOrder charge the card?" });
      assert.deepEqual(result.symbols.map((symbol: any) => symbol.name), ["placeOrder", "chargeCard"]);
      assert.match(result.symbols[0].source, /return chargeCard\(orderId\)/u);
      assert.equal(result.symbols[1].callers, 1);
      assert.deepEqual(result.paths.map((entry: any) => entry.path.length), [2]);
      assert.match(result.paths[0].from, /^placeOrder/u);
      assert.match(result.paths[0].to, /^chargeCard/u);
      assert.deepEqual(result.impact.routes, ["POST /orders"]);

      const bySymbol = await call(store, "explore", { symbol: "chargeCard" });
      assert.equal(bySymbol.symbols.length, 1);
      const byFile = await call(store, "explore", { file: "src/users.ts" });
      assert.deepEqual(byFile.symbols.map((symbol: any) => symbol.name), ["listUsers"]);

      const none = await call(store, "explore", { question: "zzzqqq frobnicate" });
      assert.equal(none.total, 0);
      assert.match(none.note, /Nothing matched/u);
      await assert.rejects(() => callMcpTool(store, "explore", {}), /needs a question, a symbol or a file/u);
    } finally {
      await store.close();
    }
  });

  it("takes identifiers out of a question and finds chains between symbols", () => {
    assert.deepEqual(questionTerms("How does the OrderService.place flow reach chargeCard?"), ["OrderService.place", "place", "chargeCard"]);
    assert.ok(!questionTerms("what is the flow of the code").includes("flow"));
    const edges = [{ caller: "a", callee: "b", line: 1 }, { caller: "b", callee: "c", line: 2 }, { caller: "x", callee: "c", line: 3 }];
    assert.deepEqual(callPaths(edges, ["a", "c"]), [["a", "b", "c"]]);
    assert.deepEqual(callPaths(edges, ["c"]), []);
  });
});

describe("trace_calls", () => {
  it("lists callees and finds the chain between two functions", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-trace-project-"));
    for (const [file, text] of Object.entries(FILES)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), text);
    }
    const store = await scan(root);
    try {
      const callees = await call(store, "trace_calls", { from: "placeOrder" });
      assert.deepEqual(callees.callees.map((entry: any) => [entry.name, entry.depth, entry.calledBy]), [["chargeCard", 1, "placeOrder"]]);

      const path = await call(store, "trace_calls", { from: "placeOrder", to: "chargeCard" });
      assert.equal(path.found, true);
      assert.equal(path.paths[0].calls, 1);
      assert.equal(path.paths[0].weakest, "exact");
      assert.deepEqual(path.paths[0].path.map((hop: any) => hop.name), ["placeOrder", "chargeCard"]);

      const none = await call(store, "trace_calls", { from: "chargeCard", to: "placeOrder" });
      assert.equal(none.found, false);
      assert.match(none.note, /No chain/u);
      assert.match((await call(store, "trace_calls", { from: "nope" })).note, /No function or method matched/u);
    } finally {
      await store.close();
    }
  });

  it("names the weakest link of a chain", async () => {
    const store = await scan(path.resolve("fixtures/python-calls"));
    try {
      const result = await call(store, "trace_calls", { from: "save_all", to: "save" });
      assert.equal(result.paths[0].weakest, "inferred");
      assert.ok(result.paths[0].path.some((hop: any) => hop.provenance === "inferred"));
    } finally {
      await store.close();
    }
  });
});

describe("edge provenance", () => {
  it("is derived from via and match, and stored since schema 88", async () => {
    assert.ok(SCHEMA_VERSION >= 88);
    assert.equal(provenanceOf({ type: "CALL_RESOLVES_TO", properties: {} }), "exact");
    assert.equal(provenanceOf({ type: "CALL_RESOLVES_TO", properties: { via: "grpc" } }), "framework");
    assert.equal(provenanceOf({ type: "CALL_RESOLVES_TO", properties: { via: "override" } }), "inferred");
    assert.equal(provenanceOf({ type: "REQUESTS", properties: { match: "exact" } }), "exact");
    assert.equal(provenanceOf({ type: "REQUESTS", properties: { match: "catch-all" } }), "inferred");
    assert.equal(provenanceOf({ type: "USES_STYLE", properties: { match: "name" } }), "by-name");
    assert.equal(provenanceOf({ type: "USES_STYLE", properties: { match: "module" } }), "exact");
    assert.equal(provenanceOf({ type: "CALLS", properties: {} }), null);
  });

  it("find_callers marks links that are not exact", async () => {
    const store = await scan(path.resolve("fixtures/python-calls"));
    try {
      const rows = await store.query("MATCH ()-[r:CALL_RESOLVES_TO]->() RETURN r.provenance AS provenance, count(r) AS n") as Array<{ provenance: string; n: number }>;
      assert.ok(rows.every((row) => ["exact", "inferred", "framework", "by-name"].includes(row.provenance)), JSON.stringify(rows));
      assert.ok(rows.some((row) => row.provenance === "inferred"));

      const { callers } = await call(store, "find_callers", { name: "save" });
      const viaBase = callers.find((row: any) => row.caller === "save_all");
      assert.equal(viaBase.provenance, "inferred");
      assert.ok(callers.some((row: any) => row.provenance === undefined), "exact links carry no provenance");
    } finally {
      await store.close();
    }
  });
});

describe("rankSymbols", () => {
  it("does not let an exact match on a very common word outrank the rest of the question", () => {
    const make = (name: string, file: string, i: number) => ({ id: `${file}#${i}`, kind: "function" as const, name, className: null, file, path: `/p/${file}`, line: 1, endLine: 2 });
    const symbols = [
      ...Array.from({ length: 300 }, (_, i) => make("server", `fixtures/f${i}.go`, i)),
      make("annotateStale", "src/freshness.ts", 1000),
    ];
    const ranked = rankSymbols(symbols, ["server", "annotate", "stale"]);
    assert.equal(ranked[0]!.symbol.file, "src/freshness.ts");
  });
});

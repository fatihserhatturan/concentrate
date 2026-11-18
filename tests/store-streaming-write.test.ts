import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { MemoryGraph } from "../src/adapters/store/graph.js";
import { commitScannedSnapshot, commitSnapshot, readHead } from "../src/adapters/store/persistence.js";
import { SCHEMA_VERSION } from "../src/adapters/store/schema.js";
import { GraphStore } from "../src/adapters/store/store.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

const workRoot = await mkdtemp(path.join(os.tmpdir(), "concentrate-stream-"));
after(() => rm(workRoot, { recursive: true, force: true }));

let counter = 0;
const freshDirectory = () => path.join(workRoot, `store-${counter++}`);

async function segmentFiles(directory: string, segments: Record<string, string>): Promise<Record<string, Buffer>> {
  const result: Record<string, Buffer> = {};
  for (const [key, file] of Object.entries(segments)) result[key] = await readFile(path.join(directory, "segments", file));
  return result;
}

/** Commit through the MemoryGraph path and the streaming path and compare every byte but writtenAt. */
async function assertIdentical(nodes: GraphNode[], relationships: GraphRelationship[]): Promise<void> {
  const legacy = freshDirectory();
  const graph = new MemoryGraph();
  graph.write(nodes, relationships);
  const expected = await commitSnapshot(legacy, graph, { schemaVersion: SCHEMA_VERSION, previous: null });

  const streamed = freshDirectory();
  const actual = await commitScannedSnapshot(streamed, nodes, relationships, { schemaVersion: SCHEMA_VERSION, previous: null });

  assert.deepEqual({ ...actual, writtenAt: "" }, { ...expected, writtenAt: "" });
  assert.deepEqual(await readdir(path.join(streamed, "segments")), await readdir(path.join(legacy, "segments")));
  assert.deepEqual(await segmentFiles(streamed, actual.segments), await segmentFiles(legacy, expected.segments));
  assert.deepEqual({ ...(await readHead(streamed)), writtenAt: "" }, { ...expected, writtenAt: "" });
}

const fixtures = ["call-resolution", "express-koa-routes", "class-calls"];

describe("streaming snapshot write", () => {
  for (const fixture of fixtures) {
    it(`writes the same segments as the MemoryGraph path for the ${fixture} fixture`, async () => {
      const built = await buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: false });
      assert.ok(built.nodes.length > 0 && built.relationships.length > 0);
      const files = built.nodes.filter((node) => node.label === "File");
      const functions = built.nodes.filter((node) => node.label === "Function");
      assert.ok(files.length >= 2 && functions.length >= 2);

      const calls = built.relationships.filter((relationship) => relationship.type === "CALL_RESOLVES_TO");
      assert.ok(calls.length > 0 || fixture === "express-koa-routes");
      const extra: GraphRelationship[] = [
        // missing endpoints are dropped in both paths
        { from: functions[0]!.id, to: "file:does-not-exist", type: "DEFINES_FUNCTION", properties: {} },
        { from: "file:does-not-exist", to: functions[0]!.id, type: "DEFINES_FUNCTION", properties: {} },
        // provenance (framework) and a duplicated relationship
        ...calls.slice(0, 2).flatMap((call) => [
          { ...call, properties: { ...call.properties, via: "grpc" } },
          { ...call, properties: { ...call.properties, via: "grpc" } },
        ]),
      ];
      const duplicated = built.relationships.slice(0, 5);
      await assertIdentical(built.nodes, [...built.relationships, ...duplicated, ...extra]);
    });
  }

  it("writes an empty graph", async () => {
    await assertIdentical([], []);
  });

  it("reuses unchanged segments of the previous HEAD", async () => {
    const built = await buildCodeGraph(path.resolve("fixtures", "call-resolution"), { continueOnError: false });
    const directory = freshDirectory();
    const first = await commitScannedSnapshot(directory, built.nodes, built.relationships, { schemaVersion: SCHEMA_VERSION, previous: null });
    const second = await commitScannedSnapshot(directory, built.nodes, built.relationships, { schemaVersion: SCHEMA_VERSION, previous: first });
    assert.equal(second.generation, 2);
    assert.deepEqual(second.segments, first.segments);
  });

  it("throws the MemoryGraph errors and leaves HEAD alone", async () => {
    const directory = freshDirectory();
    const node = (id: string, label: string, properties = {}) => ({ id, label, properties }) as GraphNode;
    const store = await GraphStore.open(directory);
    await store.reset();
    await store.write([node("file:a.ts", "File", { relativePath: "a.ts" })], []);
    await store.reset();

    await assert.rejects(store.write([node("x", "Nope")], []), /Cannot write node x: table Nope does not exist/);
    await assert.rejects(store.write([node("file:a.ts", "File"), node("file:a.ts", "File")], []), /Cannot write node file:a.ts: duplicate primary key/);
    await assert.rejects(store.write([node("file:a.ts", "File", { bogus: "x" })], []), /unknown property bogus/);
    await assert.rejects(
      store.write([node("file:a.ts", "File"), node("file:a.ts:function:f", "Function")], [
        { from: "file:a.ts", to: "file:a.ts:function:f", type: "CALL_RESOLVES_TO", properties: {} },
      ] as GraphRelationship[]),
      /Cannot write CALL_RESOLVES_TO from File file:a.ts to Function file:a.ts:function:f: expected/,
    );
    assert.equal((await readHead(directory))!.generation, 1);

    // still in the pending-reset state: a good write commits
    await store.write([node("file:b.ts", "File", { relativePath: "b.ts" })], []);
    assert.equal((await readHead(directory))!.generation, 2);
    assert.deepEqual(await store.query("MATCH (f:File) RETURN f.relativePath AS path"), [{ path: "b.ts" }]);
  });
});

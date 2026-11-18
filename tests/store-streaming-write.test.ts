import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { MemoryGraph } from "../src/adapters/store/graph.js";
import { commitScannedSnapshot, commitSnapshot, loadSnapshot, readHead, serializeSegments } from "../src/adapters/store/persistence.js";
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

  it("loads a snapshot segment by segment into the same graph", async () => {
    for (const fixture of fixtures) {
      const built = await buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: false });
      const expected = new MemoryGraph();
      expected.write(built.nodes, built.relationships);
      const directory = freshDirectory();
      await commitScannedSnapshot(directory, built.nodes, built.relationships, { schemaVersion: SCHEMA_VERSION, previous: null });
      const { graph } = await loadSnapshot(directory);
      assert.equal(graph.nodeCount, expected.nodeCount);
      assert.equal(graph.relationshipCount, expected.relationshipCount);
      assert.deepEqual(serializeSegments(graph), serializeSegments(expected));
    }
  });

  it("reports a relationship whose endpoint is in no segment as corruption", async () => {
    const directory = freshDirectory();
    const nodes = [{ id: "file:a.ts", label: "File", properties: { relativePath: "a.ts" } }] as GraphNode[];
    const head = await commitScannedSnapshot(directory, nodes, [], { schemaVersion: SCHEMA_VERSION, previous: null });
    const broken = `${JSON.stringify(["r", "DEFINES_FUNCTION", "file:a.ts", "file:a.ts:function:gone", {}])}\n`;
    const file = "ffffffffffffffffffffffffffffffff.jsonl.gz";
    await writeFile(path.join(directory, "segments", file), gzipSync(broken));
    await writeFile(path.join(directory, "HEAD.json"), JSON.stringify({ ...head, segments: { ...head.segments, global: file } }));
    await assert.rejects(loadSnapshot(directory), /Corrupt graph store .*DEFINES_FUNCTION file:a.ts -> file:a.ts:function:gone has a missing endpoint/);
  });
});

describe("loading a large segment", () => {
  it("streams a segment over 1 MB compressed and loads the same graph, multi-byte text included", async () => {
    // Package nodes and relationships between them belong to the global segment.
    const random = (index: number) => `${index}-${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;
    const nodes: GraphNode[] = Array.from({ length: 40_000 }, (_, index) => ({
      id: `package:${random(index)}`,
      label: "Package",
      properties: { name: `pkg-${random(index)}-ü日本`, relativePath: random(index) },
    }));
    const relationships: GraphRelationship[] = nodes.slice(1).map((node, index) => ({
      from: nodes[index]!.id, to: node.id, type: "PACKAGE_IMPORTS_PACKAGE", properties: {},
    }));
    const directory = freshDirectory();
    const head = await commitScannedSnapshot(directory, nodes, relationships, { schemaVersion: SCHEMA_VERSION, previous: null });
    const file = path.join(directory, "segments", head.segments.global!);
    assert.ok((await readFile(file)).length > 1 << 20, "the global segment must be large enough to be streamed");

    const { graph } = await loadSnapshot(directory);
    assert.equal(graph.nodeCount, nodes.length);
    assert.equal(graph.relationshipCount, relationships.length);
    assert.deepEqual(graph.node(nodes[123]!.id)?.properties, nodes[123]!.properties);
    assert.equal(graph.node(nodes[5]!.id)?.outgoing[0]?.to.id, nodes[6]!.id);
  });
});

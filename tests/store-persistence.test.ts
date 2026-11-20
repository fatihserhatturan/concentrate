import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { MemoryGraph } from "../src/adapters/store/graph.js";
import { defaultGraphSchemaIndex } from "../src/composition/default-schema.js";
import { GraphLockError } from "../src/adapters/store/lock.js";
import { commitSnapshot, GLOBAL_SEGMENT, loadSnapshot, readHead, serializeSegments } from "../src/adapters/store/persistence.js";
import { BASE_SCHEMA_VERSION as SCHEMA_VERSION } from "../src/core/graph/schema.js";
import { GraphStore } from "../src/adapters/store/store.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { openTestStore } from "./helpers/store.js";

const workRoot = await mkdtemp(path.join(os.tmpdir(), "concentrate-store-"));
after(() => rm(workRoot, { recursive: true, force: true }));

let counter = 0;
const freshDirectory = () => path.join(workRoot, `store-${counter++}`);

const nodes = (names: string[]): GraphNode[] => [
  { id: "repo", label: "Repo", properties: { name: "demo", path: "/demo" } },
  ...["a.ts", "b.ts"].map((file) => ({ id: `file:${file}`, label: "File", properties: { relativePath: file } })),
  ...names.map((name) => ({ id: `file:a.ts:function:${name}`, label: "Function", properties: { name } })),
] as GraphNode[];

const relationships = (names: string[]): GraphRelationship[] => names.map((name) => (
  { from: "file:a.ts", to: `file:a.ts:function:${name}`, type: "DEFINES_FUNCTION", properties: {} }
)) as GraphRelationship[];

function graphOf(names: string[]): MemoryGraph {
  const graph = new MemoryGraph(defaultGraphSchemaIndex);
  graph.write(nodes(names), relationships(names));
  return graph;
}

describe("snapshot persistence", () => {
  it("round-trips a graph and splits it by owning file", async () => {
    const directory = freshDirectory();
    const graph = graphOf(["run", "stop"]);
    const head = await commitSnapshot(directory, graph, { previous: null });
    assert.equal(head.generation, 1);
    assert.deepEqual(Object.keys(head.segments).sort(), ["file:a.ts", "file:b.ts", GLOBAL_SEGMENT]);
    const loaded = await loadSnapshot(directory, defaultGraphSchemaIndex);
    assert.deepEqual(loaded.head, head);
    assert.deepEqual(serializeSegments(loaded.graph), serializeSegments(graph));
  });

  it("rewrites only segments whose content changed", async () => {
    const directory = freshDirectory();
    const first = await commitSnapshot(directory, graphOf(["run"]), { previous: null });
    const second = await commitSnapshot(directory, graphOf(["run", "stop"]), { previous: first });
    assert.equal(second.generation, 2);
    assert.notEqual(second.segments["file:a.ts"], first.segments["file:a.ts"]);
    assert.equal(second.segments["file:b.ts"], first.segments["file:b.ts"]);
    assert.equal(second.segments[GLOBAL_SEGMENT], first.segments[GLOBAL_SEGMENT]);
  });

  it("keeps unreferenced segments for a grace period, then collects them", async () => {
    const directory = freshDirectory();
    const first = await commitSnapshot(directory, graphOf(["run"]), { previous: null });
    const second = await commitSnapshot(directory, graphOf(["stop"]), { previous: first });
    const segmentsDirectory = path.join(directory, "segments");
    const old = first.segments["file:a.ts"]!;
    assert.ok((await readdir(segmentsDirectory)).includes(old));

    const longAgo = new Date(Date.now() - 120_000);
    await utimes(path.join(segmentsDirectory, old), longAgo, longAgo);
    await commitSnapshot(directory, graphOf(["stop"]), { previous: second });
    assert.ok(!(await readdir(segmentsDirectory)).includes(old));
  });

  it("rejects an unknown store format", async () => {
    const directory = freshDirectory();
    await commitSnapshot(directory, graphOf([]), { previous: null });
    const headPath = path.join(directory, "HEAD.json");
    const head = JSON.parse(await readFile(headPath, "utf8"));
    await writeFile(headPath, JSON.stringify({ ...head, format: 99 }));
    await assert.rejects(readHead(directory), /Unsupported graph store format 99/);
  });
});

describe("GraphStore", () => {
  it("commits reset + write and reads it back after reopening", async () => {
    const directory = freshDirectory();
    const writer = await openTestStore(directory);
    assert.equal(await writer.schemaVersion(), null);
    await writer.reset();
    assert.equal(await writer.schemaVersion(), SCHEMA_VERSION);
    await writer.write(nodes(["run"]), relationships(["run"]));
    await writer.close();

    const reader = await openTestStore(directory);
    assert.deepEqual(await reader.query("MATCH (f:File)-[:DEFINES_FUNCTION]->(fn:Function) RETURN f.relativePath AS file, fn.name AS fn"), [
      { file: "a.ts", fn: "run" },
    ]);
    assert.deepEqual(await reader.query("MATCH (fn:Function) WHERE fn.name = $name RETURN count(*) AS n", { name: "run" }), [{ n: 1 }]);
    const stats = await reader.stats();
    assert.deepEqual(stats.find((row) => row.table === "Function"), { table: "Function", count: 1 });
    await reader.close();
  });

  it("lets a reader see a newer generation without reopening", async () => {
    const directory = freshDirectory();
    const writer = await openTestStore(directory);
    await writer.reset();
    await writer.write(nodes(["run"]), relationships(["run"]));
    const reader = await openTestStore(directory);
    assert.deepEqual(await reader.query("MATCH (fn:Function) RETURN fn.name AS name"), [{ name: "run" }]);

    await writer.reset();
    await writer.write(nodes(["stop"]), relationships(["stop"]));
    assert.deepEqual(await reader.query("MATCH (fn:Function) RETURN fn.name AS name"), [{ name: "stop" }]);
  });

  it("commits a pending reset on close", async () => {
    const directory = freshDirectory();
    const writer = await openTestStore(directory);
    await writer.reset();
    await writer.write(nodes(["run"]), relationships(["run"]));
    await writer.reset();
    await writer.close();
    const reader = await openTestStore(directory);
    assert.deepEqual(await reader.query("MATCH (n) RETURN count(n) AS n"), [{ n: 0 }]);
  });

  it("drops a write that fails validation", async () => {
    const directory = freshDirectory();
    const store = await openTestStore(directory);
    await store.reset();
    await store.write(nodes(["run"]), relationships(["run"]));
    await assert.rejects(store.write(nodes(["again"]), []), /duplicate primary key/);
    assert.deepEqual(await store.query("MATCH (fn:Function) RETURN fn.name AS name"), [{ name: "run" }]);
    assert.equal((await readHead(directory))!.generation, 1);
  });

  it("recognizes an old Kuzu database and refuses unrelated directories", async () => {
    const kuzuFile = path.join(workRoot, "graph.kuzu");
    await writeFile(kuzuFile, "KUZU");
    await assert.rejects(openTestStore(kuzuFile), /is a Kuzu database from an older version of Concentrate; delete it and run concentrate scan again/);

    const kuzuDirectory = freshDirectory();
    await mkdir(kuzuDirectory);
    await writeFile(path.join(kuzuDirectory, "catalog.kz"), "");
    await assert.rejects(openTestStore(kuzuDirectory), /is a Kuzu database/);

    const other = freshDirectory();
    await mkdir(other);
    await writeFile(path.join(other, "notes.txt"), "");
    await assert.rejects(openTestStore(other), /is not a Concentrate graph store \(found notes.txt\)/);
  });

  it("does not create a store just by reading it", async () => {
    const directory = freshDirectory();
    const reader = await openTestStore(directory);
    assert.equal(await reader.schemaVersion(), null);
    assert.deepEqual(await reader.query("MATCH (n) RETURN count(n) AS n"), [{ n: 0 }]);
    await reader.close();
    await assert.rejects(readdir(directory), { code: "ENOENT" });
  });

  it("fails fast on a held lock unless asked to wait", async () => {
    const directory = freshDirectory();
    const store = await openTestStore(directory);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, "LOCK"), JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }));
    await store.reset();
    await assert.rejects(store.write(nodes([]), []), GraphLockError);

    const waiting = await openTestStore(directory, { retryLock: true });
    await waiting.reset();
    const pending = waiting.write(nodes(["run"]), relationships(["run"]));
    setTimeout(() => void rm(path.join(directory, "LOCK")), 100);
    await pending;
    assert.equal((await readHead(directory))!.nodes, 4);
  });
});

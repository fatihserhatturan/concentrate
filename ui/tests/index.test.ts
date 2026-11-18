import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { projectInfo } from "../server/api/project.js";
import { runScan } from "../server/api/scan.js";
import { graphPath, invalidateIndex, loadIndex, readRawGraph } from "../server/graph/index.js";

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
let work: string;
let project: string;

before(async () => {
  work = await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-index-"));
  project = path.join(work, "project");
  await cp(path.join(FIXTURES, "express-koa-routes"), project, { recursive: true });
  await writeFile(path.join(project, "a.ts"), "export function helper() { return 1; }\n");
  await writeFile(path.join(project, "b.ts"), 'import { helper } from "./a";\nexport function main() { return helper(); }\nexport function load() { return fetch("/api/users/1", { method: "PUT" }); }\n');
  let done = false;
  await runScan({ path: project }, (event) => { if (event.type === "done") done = true; });
  assert.ok(done, "the fixture scan finished");
});
after(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("projectInfo", () => {
  it("reads nodes, schema version and scan time from HEAD.json without opening the store", async () => {
    const lonely = path.join(work, "head-only");
    await mkdir(graphPath(lonely), { recursive: true });
    const writtenAt = "2026-01-02T03:04:05.000Z";
    await writeFile(path.join(graphPath(lonely), "HEAD.json"), JSON.stringify({ format: "x", schemaVersion: 7, generation: 3, writtenAt, nodes: 42, relationships: 1, segments: [] }));
    const info = await projectInfo(lonely);
    assert.deepEqual([info.hasGraph, info.nodes, info.schemaVersion, info.scannedAt], [true, 42, 7, writtenAt]);
  });

  it("agrees with the HEAD.json the store wrote", async () => {
    const head = JSON.parse(await readFile(path.join(graphPath(project), "HEAD.json"), "utf8"));
    const info = await projectInfo(project);
    assert.equal(info.nodes, head.nodes);
    assert.equal(info.schemaVersion, head.schemaVersion);
    assert.equal(info.scannedAt, new Date(head.writtenAt).toISOString());
  });

  it("a graph folder without HEAD.json is no graph", async () => {
    const empty = path.join(work, "empty-graph");
    await mkdir(graphPath(empty), { recursive: true });
    assert.equal((await projectInfo(empty)).hasGraph, false);
  });
});

describe("graph index", () => {
  it("builds once for concurrent requests, and again after a scan invalidated it", async () => {
    invalidateIndex(project);
    const [a, b, c] = await Promise.all([loadIndex(project), loadIndex(project), loadIndex(project)]);
    assert.equal(a, b);
    assert.equal(b, c);
    assert.equal(await loadIndex(project), a, "later calls hit the cache");
    invalidateIndex(project);
    assert.notEqual(await loadIndex(project), a);
  });

  it("keeps no Call or Import nodes, and no relationship that touches one", async () => {
    const index = await loadIndex(project);
    const raw = await readRawGraph(project);
    const collapsed = new Set(raw.nodes.filter((n) => n.label === "Call" || n.label === "Import").map((n) => n.id));
    assert.ok(collapsed.size > 0, "the fixture has calls or imports");
    assert.ok([...index.nodes.values()].every((n) => n.label !== "Call" && n.label !== "Import"));
    for (const edge of index.stored) assert.ok(!collapsed.has(edge.from) && !collapsed.has(edge.to));
    assert.ok(index.stored.length < raw.edges.length);
    assert.equal(index.nodes.size + collapsed.size, raw.nodes.length);
    for (const id of index.fileOf.keys()) assert.ok(index.nodes.has(id), "ownership names only kept nodes");
    for (const list of index.declared.values()) for (const id of list) assert.ok(index.nodes.has(id));
  });

  it("still has the derived import and call edges", async () => {
    const index = await loadIndex(project);
    const imports = index.edges.filter((e) => e.type === "IMPORTS");
    assert.ok(imports.length > 0);
    assert.ok(imports.every((e) => index.nodes.get(e.from)?.label === "File" && index.nodes.get(e.to)?.label === "File"));
    const calls = index.edges.filter((e) => e.type === "CALLS");
    assert.ok(calls.length > 0);
    assert.ok(calls.every((e) => index.nodes.has(e.from) && index.nodes.has(e.to)));
    const named = (id: string) => String(index.nodes.get(id)?.props.name);
    assert.ok(calls.some((e) => named(e.from) === "main" && named(e.to) === "helper"), "main calls helper");
    const request = index.edges.find((e) => e.type === "REQUESTS");
    assert.ok(request, "the fetch is attributed to a route");
    assert.equal(named(request.from), "load", "the request is attributed to the function that made it");
    assert.equal(index.nodes.get(request.to)?.label, "Route");
    const seen = new Set<string>();
    for (const edge of index.edges) {
      const key = `${edge.from}\0${edge.to}\0${edge.type}`;
      assert.ok(!seen.has(key), "no duplicate edge");
      seen.add(key);
    }
  });

  it("the raw graph for the whole-graph export has every stored node and relationship", async () => {
    const raw = await readRawGraph(project);
    const head = JSON.parse(await readFile(path.join(graphPath(project), "HEAD.json"), "utf8"));
    assert.equal(raw.nodes.length, head.nodes);
    assert.equal(raw.edges.length, head.relationships);
    assert.ok(raw.nodes.some((n) => n.label === "Call"));
  });
});

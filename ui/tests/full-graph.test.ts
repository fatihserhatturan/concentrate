import assert from "node:assert/strict";
import { cp, mkdtemp, realpath, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createUiServer } from "../server/index.js";

const TOKEN = "t";
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const auth = { "x-concentrate-token": TOKEN };
let server: ReturnType<typeof createUiServer>;
let base: string;
let work: string;
let project: string;

const get = async (pathAndQuery: string) => {
  const response = await fetch(`${base}${pathAndQuery}${pathAndQuery.includes("?") ? "&" : "?"}project=${encodeURIComponent(project)}`, { headers: auth });
  assert.equal(response.status, 200, await response.clone().text());
  return response;
};

before(async () => {
  server = createUiServer(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await realpath(await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-full-")));
  project = path.join(work, "project");
  await cp(path.join(ROOT, "fixtures", "call-resolution"), project, { recursive: true });
  const scan = await fetch(`${base}/api/scan`, { method: "POST", headers: auth, body: JSON.stringify({ path: project }) });
  assert.match(await scan.text(), /event: done/);
});
after(async () => {
  server.close();
  await rm(work, { recursive: true, force: true });
});

describe("GET /api/graph/full", () => {
  it("returns every connected node with its cluster, degree and the relationships between them", async () => {
    const body = await (await get("/api/graph/full")).json();
    assert.ok(body.nodes.length > 0 && body.edges.length > 0);
    assert.equal(body.truncated, false);
    assert.equal(body.total, body.nodes.length);
    const ids = new Set<string>(body.nodes.map((n: { id: string }) => n.id));
    for (const edge of body.edges) assert.ok(ids.has(edge.from) && ids.has(edge.to), "edges join returned nodes");
    for (const node of body.nodes) {
      assert.equal(typeof node.group, "string");
      assert.ok(node.degree > 0, "isolated nodes are left out");
    }
    assert.equal(body.groups.reduce((n: number, g: { count: number }) => n + g.count, 0), body.nodes.length);
    assert.ok(body.nodes.some((n: { label: string }) => n.label === "Function"), "symbols are in it, not only files");
  });

  it("keeps the most connected nodes above the limit and says so", async () => {
    const all = await (await get("/api/graph/full")).json();
    const limit = Math.max(2, Math.floor(all.nodes.length / 2));
    const cut = await (await get(`/api/graph/full?limit=${limit}`)).json();
    assert.equal(cut.nodes.length, limit);
    assert.equal(cut.truncated, true);
    assert.equal(cut.total, all.nodes.length);
    const lowest = Math.min(...cut.nodes.map((n: { degree: number }) => n.degree));
    const dropped = all.nodes.filter((n: { id: string }) => !cut.nodes.some((k: { id: string }) => k.id === n.id));
    assert.ok(dropped.every((n: { degree: number }) => n.degree <= lowest), "what was dropped is not more connected than what was kept");
  });

  it("filters relationships by kind and drops nodes left without any", async () => {
    const calls = await (await get("/api/graph/full?types=calls")).json();
    assert.ok(calls.edges.length > 0 && calls.edges.every((e: { kind: string }) => e.kind === "calls"));
    const none = await (await get("/api/graph/full?types=env")).json();
    assert.ok(none.nodes.length <= calls.nodes.length);
    assert.equal((await fetch(`${base}/api/graph/full?project=${encodeURIComponent(project)}&types=nope`, { headers: auth })).status, 400);
  });

  it("needs the token", async () => {
    assert.equal((await fetch(`${base}/api/graph/full?project=${encodeURIComponent(project)}`)).status, 401);
  });
});

describe("HTML export", () => {
  it("carries clusters, degrees, positions and the palette of the app's graph screen", async () => {
    const html = await (await get("/api/export?format=html&scope=graph")).text();
    const data = JSON.parse(/<script id="graph-data" type="application\/json">(.*?)<\/script>/s.exec(html)![1]!.replace(/\\u003c/g, "<"));
    assert.ok(data.clusters.length > 0 && data.clusters.every((c: { r: number }) => c.r > 0));
    assert.ok(data.nodes.every((n: { g: string; d: number; x: number; y: number }) => typeof n.g === "string" && typeof n.d === "number" && Number.isFinite(n.x) && Number.isFinite(n.y)));
    assert.equal(data.colors.Function, "#1a7f37");
    assert.ok(data.edges.every((e: { c: string }) => typeof e.c === "string"));
  });
});

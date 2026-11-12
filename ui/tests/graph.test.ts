import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createUiServer } from "../server/index.js";

const TOKEN = "t";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
let server: ReturnType<typeof createUiServer>;
let base: string;
let work: string;
let project: string;
const auth = { "x-concentrate-token": TOKEN };

async function get(pathAndQuery: string, status = 200) {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const response = await fetch(`${base}${pathAndQuery}${sep}project=${encodeURIComponent(project)}`, { headers: auth });
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<any>;
}

before(async () => {
  server = createUiServer(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-graph-"));
  project = path.join(work, "project");
  await cp(path.join(FIXTURES, "express-koa-routes"), project, { recursive: true });
  const scan = await fetch(`${base}/api/scan`, { method: "POST", headers: auth, body: JSON.stringify({ path: project }) });
  assert.match(await scan.text(), /event: done/);
});
after(async () => {
  server.close();
  await rm(work, { recursive: true, force: true });
});

describe("graph API", () => {
  it("needs a scanned project", async () => {
    const response = await fetch(`${base}/api/graph/summary?project=${encodeURIComponent(work)}`, { headers: auth });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /scan the project first/);
  });

  it("summary has counts and languages", async () => {
    const body = await get("/api/graph/summary");
    assert.ok(body.files.total > 0);
    assert.ok(body.languages.length > 0);
  });

  it("overview groups files at each level", async () => {
    const files = await get("/api/graph/overview?level=file");
    assert.ok(files.nodes.length > 0);
    assert.ok(files.nodes.every((n: any) => n.label === "File"));
    const packages = await get("/api/graph/overview?level=package");
    assert.ok(packages.nodes.length >= 1);
    const dirs = await get("/api/graph/overview?level=directory");
    assert.ok(dirs.nodes.length >= 1);
    await get("/api/graph/overview?level=nope", 400);
  });

  it("search finds symbols and focuses them", async () => {
    const files = await get("/api/graph/overview?level=file");
    const any = files.nodes[0].name.split("/").pop().replace(/\.[^.]+$/, "");
    const body = await get(`/api/search?q=${encodeURIComponent(any)}`);
    assert.ok(body.total > 0);
    assert.ok(body.results[0].id);
    await get("/api/search?q=%20", 400);
  });

  it("node detail, source and neighbors agree", async () => {
    const found = await get("/api/search?q=&label=File".replace("q=", "q=."));
    const file = found.results.find((r: any) => r.label === "File") ?? (await get("/api/search?q=js&label=File")).results[0];
    assert.ok(file, "a file result");
    const detail = await get(`/api/graph/node?id=${encodeURIComponent(file.id)}`);
    assert.equal(detail.label, "File");
    const source = await get(`/api/graph/source?id=${encodeURIComponent(file.id)}`);
    assert.ok(typeof source.source === "string" && source.source.length > 0);
    const around = await get(`/api/graph/neighbors?id=${encodeURIComponent(file.id)}&depth=1`);
    assert.ok(around.nodes.some((n: any) => n.id === file.id));
    assert.ok(around.nodes.length > 1, "a file brings its declarations");
    await get("/api/graph/node?id=missing", 400);
  });

  it("unknown relationship kinds are rejected", async () => {
    await get("/api/graph/overview?level=file&types=bogus", 400);
  });
});

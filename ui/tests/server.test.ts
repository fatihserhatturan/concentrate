import assert from "node:assert/strict";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createUiServer } from "../server/index.js";
import { isAllowedHost } from "../server/security.js";

const TOKEN = "test-token";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
let server: ReturnType<typeof createUiServer>;
let base: string;
let work: string;

before(async () => {
  server = createUiServer(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-"));
  await cp(path.join(FIXTURES, "call-graph"), path.join(work, "project"), { recursive: true });
});
after(async () => {
  server.close();
  await rm(work, { recursive: true, force: true });
});

const auth = { "x-concentrate-token": TOKEN };

describe("security", () => {
  it("rejects API calls without the token", async () => {
    assert.equal((await fetch(`${base}/api/fs`)).status, 401);
    assert.equal((await fetch(`${base}/api/fs`, { headers: { "x-concentrate-token": "nope" } })).status, 401);
  });
  it("checks the Host header", () => {
    assert.equal(isAllowedHost("127.0.0.1:4000"), true);
    assert.equal(isAllowedHost("localhost:4000"), true);
    assert.equal(isAllowedHost("[::1]:4000"), true);
    assert.equal(isAllowedHost("evil.example.com"), false);
    assert.equal(isAllowedHost("127.0.0.1.evil.com"), false);
    assert.equal(isAllowedHost(undefined), false);
  });
  it("binds to loopback only", () => {
    assert.equal((server.address() as AddressInfo).address, "127.0.0.1");
  });
});

describe("GET /api/fs", () => {
  it("lists directories with git and graph flags", async () => {
    const response = await fetch(`${base}/api/fs?path=${encodeURIComponent(work)}`, { headers: auth });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.path, work);
    assert.deepEqual(body.entries.map((e: { name: string }) => e.name), ["project"]);
    assert.equal(body.entries[0].hasGraph, false);
  });
  it("errors on a missing path", async () => {
    assert.equal((await fetch(`${base}/api/fs?path=${encodeURIComponent(path.join(work, "nope"))}`, { headers: auth })).status, 400);
  });
});

describe("POST /api/scan", () => {
  it("streams progress and writes .concentrate/graph in the project", async () => {
    const project = path.join(work, "project");
    const response = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: progress/);
    const done = JSON.parse(/event: done\ndata: (.*)\n/.exec(text)![1]);
    assert.equal(done.status, "ok");
    assert.ok(done.nodes > 0);
    assert.equal(done.database, path.join(project, ".concentrate", "graph"));
    const manifest = JSON.parse(await readFile(path.join(project, ".concentrate", "scan-manifest.json"), "utf8"));
    assert.ok(manifest.files.length > 0);
    const listing = await (await fetch(`${base}/api/fs?path=${encodeURIComponent(work)}`, { headers: auth })).json();
    assert.equal(listing.entries[0].hasGraph, true);
  });
  it("rejects a bad body and reports a missing directory", async () => {
    const bad = await fetch(`${base}/api/scan`, { method: "POST", headers: auth, body: JSON.stringify({}) });
    assert.equal(bad.status, 400);
    const missing = await fetch(`${base}/api/scan`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ path: path.join(work, "nope") }),
    });
    assert.match(await missing.text(), /event: error/);
  });
});

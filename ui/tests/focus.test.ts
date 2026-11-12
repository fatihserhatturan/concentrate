import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createUiServer } from "../server/index.js";
import { isNoisePath } from "../server/graph/views.js";

const TOKEN = "t";
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "fixtures");
let server: ReturnType<typeof createUiServer>;
let base: string;
let work: string;
let project: string;
const auth = { "x-concentrate-token": TOKEN };

const get = async (query: string, status = 200) => {
  const response = await fetch(`${base}${query}${query.includes("?") ? "&" : "?"}project=${encodeURIComponent(project)}`, { headers: auth });
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<any>;
};
const fileId = (rel: string) => `file:${rel}`;

before(async () => {
  server = createUiServer(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-focus-"));
  project = path.join(work, "project");
  await cp(path.join(FIXTURES, "express-koa-routes"), project, { recursive: true });
  // a -> b -> c -> a is a cycle, d and a dot-directory file use a.
  await writeFile(path.join(project, "a.ts"), `import { b } from "./b";\nexport const a = () => b();\n`);
  await writeFile(path.join(project, "b.ts"), `import { c } from "./c";\nexport const b = () => c();\n`);
  await writeFile(path.join(project, "c.ts"), `import { a } from "./a";\nexport const c = () => a();\n`);
  await writeFile(path.join(project, "d.ts"), `import { a } from "./a";\nexport const d = () => a();\n`);
  await mkdir(path.join(project, ".hidden"));
  await writeFile(path.join(project, ".hidden", "x.ts"), `import { a } from "../a";\nexport const x = () => a();\n`);
  const scan = await fetch(`${base}/api/scan`, { method: "POST", headers: auth, body: JSON.stringify({ path: project }) });
  assert.match(await scan.text(), /event: done/);
});
after(async () => {
  server.close();
  await rm(work, { recursive: true, force: true });
});

describe("focus", () => {
  it("puts what uses a node on one side and what it uses on the other", async () => {
    const body = await get(`/api/graph/focus?id=${encodeURIComponent(fileId("a.ts"))}&types=imports`);
    assert.equal(body.center, fileId("a.ts"));
    assert.deepEqual(body.nodes.map((n: any) => n.name).sort(), [".hidden/x.ts", "a.ts", "b.ts", "c.ts", "d.ts"]);
    const into = body.edges.filter((e: any) => e.to === fileId("a.ts")).map((e: any) => e.from);
    const outOf = body.edges.filter((e: any) => e.from === fileId("a.ts")).map((e: any) => e.to);
    assert.deepEqual(into.sort(), [fileId(".hidden/x.ts"), fileId("c.ts"), fileId("d.ts")]);
    assert.deepEqual(outOf, [fileId("b.ts")]);
    assert.deepEqual(body.incoming, { total: 3, shown: 3 });
    assert.deepEqual(body.outgoing, { total: 1, shown: 1 });
    assert.equal(body.nodes[0].id, fileId("a.ts"), "the focused node comes first");
  });

  it("gives the same graph every time", async () => {
    const query = `/api/graph/focus?id=${encodeURIComponent(fileId("a.ts"))}&depth=2`;
    assert.deepEqual(await get(query), await get(query));
  });

  it("walks further each way with depth", async () => {
    const one = await get(`/api/graph/focus?id=${encodeURIComponent(fileId("d.ts"))}&types=imports&depth=1`);
    const three = await get(`/api/graph/focus?id=${encodeURIComponent(fileId("d.ts"))}&types=imports&depth=3`);
    assert.deepEqual(one.nodes.map((n: any) => n.name).sort(), ["a.ts", "d.ts"]);
    assert.deepEqual(three.nodes.map((n: any) => n.name).sort(), ["a.ts", "b.ts", "c.ts", "d.ts"]);
  });

  it("keeps the most connected neighbours and says how many it left out", async () => {
    const body = await get(`/api/graph/focus?id=${encodeURIComponent(fileId("a.ts"))}&types=imports&limit=5`);
    assert.equal(body.incoming.total, 3);
    const small = await get(`/api/graph/focus?id=${encodeURIComponent(fileId("a.ts"))}&types=imports&limit=5`);
    assert.deepEqual(body, small);
  });

  it("filters by relationship kind and shows declarations with defines", async () => {
    const none = await get(`/api/graph/focus?id=${encodeURIComponent(fileId("a.ts"))}&types=calls`);
    assert.equal(none.nodes.length, 1);
    const defines = await get(`/api/graph/focus?id=${encodeURIComponent(fileId("a.ts"))}&types=defines`);
    assert.ok(defines.nodes.length > 1);
    assert.ok(defines.edges.every((e: any) => e.kind === "defines"));
    await get(`/api/graph/focus?id=${encodeURIComponent(fileId("a.ts"))}&types=bogus`, 400);
    await get("/api/graph/focus?id=missing", 400);
  });
});

describe("path", () => {
  it("follows relationships in their direction when it can", async () => {
    const body = await get(`/api/graph/path?from=${encodeURIComponent(fileId("d.ts"))}&to=${encodeURIComponent(fileId("c.ts"))}&types=imports`);
    assert.equal(body.found, true);
    assert.equal(body.directed, true);
    assert.deepEqual(body.edges.map((e: any) => [e.from, e.to]), [[fileId("d.ts"), fileId("a.ts")], [fileId("a.ts"), fileId("b.ts")], [fileId("b.ts"), fileId("c.ts")]]);
  });

  it("falls back to either direction, and says so", async () => {
    const body = await get(`/api/graph/path?from=${encodeURIComponent(fileId("c.ts"))}&to=${encodeURIComponent(fileId("d.ts"))}&types=imports`);
    assert.equal(body.found, true);
    assert.equal(body.directed, false);
    assert.equal(body.edges.length, 2);
  });

  it("reports no path, and rejects unknown nodes", async () => {
    const body = await get(`/api/graph/path?from=${encodeURIComponent(fileId("a.ts"))}&to=${encodeURIComponent(fileId("paths.ts"))}&types=imports`);
    assert.deepEqual([body.found, body.nodes, body.edges], [false, [], []]);
    await get(`/api/graph/path?from=nope&to=${encodeURIComponent(fileId("a.ts"))}`, 400);
  });
});

describe("noise", () => {
  it("recognises dot-directories and build output", () => {
    for (const noisy of [".github/workflows/ci.yml", "packages/x/dist/index.js", "node_modules/a/b.js", ".claude", "a/.cache/x"]) assert.equal(isNoisePath(noisy), true, noisy);
    for (const clean of ["src/index.ts", "packages/core/a.ts", "README.md", "a/b.test.ts"]) assert.equal(isNoisePath(clean), false, clean);
  });

  it("flags noise in the overview", async () => {
    const body = await get("/api/graph/overview?level=file");
    const byName = Object.fromEntries(body.nodes.map((n: any) => [n.name, n]));
    assert.equal(byName[".hidden/x.ts"].noise, true);
    assert.equal(byName["a.ts"].noise, false);
  });
});

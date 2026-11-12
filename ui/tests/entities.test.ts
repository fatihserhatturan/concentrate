import assert from "node:assert/strict";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
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

const get = async (query: string, status = 200) => {
  const response = await fetch(`${base}${query}${query.includes("?") ? "&" : "?"}project=${encodeURIComponent(project)}`, { headers: auth });
  assert.equal(response.status, status, await response.clone().text());
  return response.json() as Promise<any>;
};

before(async () => {
  server = createUiServer(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-entities-"));
  project = path.join(work, "project");
  await cp(path.join(FIXTURES, "express-koa-routes"), project, { recursive: true });
  // a -> b -> c -> a is a cycle; d imports a and exports something nothing uses.
  await writeFile(path.join(project, "a.ts"), `import { b } from "./b";\nexport const a = () => b();\n`);
  await writeFile(path.join(project, "b.ts"), `import { c } from "./c";\nexport const b = () => c();\n`);
  await writeFile(path.join(project, "c.ts"), `import { a } from "./a";\nexport const c = () => a();\n`);
  await writeFile(path.join(project, "d.ts"), `import { a } from "./a";\nexport const d = () => a();\nexport function neverUsed() { return 1; }\n`);
  const scan = await fetch(`${base}/api/scan`, { method: "POST", headers: auth, body: JSON.stringify({ path: project }) });
  assert.match(await scan.text(), /event: done/);
});
after(async () => {
  server.close();
  await rm(work, { recursive: true, force: true });
});

describe("views", () => {
  it("catalog counts rows per view, so empty views can be hidden", async () => {
    const { views } = await get("/api/graph/catalog");
    assert.ok(views.files >= 6);
    assert.ok(views.routes > 0);
    assert.equal(views.tables, 0);
    assert.equal(views.components, 0);
  });

  it("routes table: method, path, handler, file and a summary by framework", async () => {
    const table = await get("/api/graph/entities?kind=routes");
    assert.deepEqual(table.columns.map((c: any) => c.key), ["method", "path", "handler", "framework", "file"]);
    const row = table.rows[0];
    assert.ok(row.id && row.method && row.path !== undefined && row.framework);
    assert.ok(table.rows.some((r: any) => r.handler));
    assert.equal(table.summary.by, "Framework");
    assert.equal(table.summary.groups.reduce((n: number, g: any) => n + g.count, 0), table.rows.length);
  });

  it("files table counts links between files", async () => {
    const table = await get("/api/graph/entities?kind=files");
    const byPath = Object.fromEntries(table.rows.map((r: any) => [r.path, r]));
    assert.equal(byPath["a.ts"].usedByOthers, 2); // c and d use a
    assert.equal(byPath["a.ts"].usesOthers, 1);
    assert.equal(byPath["d.ts"].usedByOthers, 0);
    assert.equal(byPath["a.ts"].language, "typescript");
  });

  it("rejects an unknown kind", async () => {
    await get("/api/graph/entities?kind=nope", 400);
  });

  it("dashboard: languages, kinds, most connected files", async () => {
    const body = await get("/api/graph/dashboard");
    assert.equal(body.languages[0].name, "typescript");
    assert.ok(body.kinds.some((k: any) => k.label === "Files"));
    assert.equal(body.topFiles[0].path, "a.ts");
    assert.equal(body.topFiles[0].usedBy, 2);
  });

  it("issues: import cycles and unused exports, with node ids", async () => {
    const body = await get("/api/graph/issues");
    assert.equal(body.cycles.length, 1);
    assert.deepEqual(body.cycles[0].files.map((f: any) => f.path).sort(), ["a.ts", "b.ts", "c.ts"]);
    assert.ok(body.cycles[0].files.every((f: any) => f.id));
    const unused = body.unused.find((u: any) => u.name === "neverUsed");
    assert.ok(unused, "the export nothing uses is listed");
    assert.equal(unused.file, "d.ts");
    assert.ok(unused.id, "it can be opened in the inspector");
    assert.match(body.note, /Candidates/);
  });
});

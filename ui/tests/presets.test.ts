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
const post = (body: unknown) => fetch(`${base}/api/query`, { method: "POST", headers: auth, body: JSON.stringify(body) });

before(async () => {
  server = createUiServer(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-presets-"));
  project = path.join(work, "project");
  await cp(path.join(FIXTURES, "express-koa-routes"), project, { recursive: true });
  // a -> b -> c -> a is a cycle; d only imports a.
  await writeFile(path.join(project, "a.ts"), `import { b } from "./b";\nexport const a = () => b();\n`);
  await writeFile(path.join(project, "b.ts"), `import { c } from "./c";\nexport const b = () => c();\n`);
  await writeFile(path.join(project, "c.ts"), `import { a } from "./a";\nexport const c = () => a();\n`);
  await writeFile(path.join(project, "d.ts"), `import { a } from "./a";\nexport const d = () => a();\n`);
  const scan = await fetch(`${base}/api/scan`, { method: "POST", headers: auth, body: JSON.stringify({ path: project }) });
  assert.match(await scan.text(), /event: done/);
});
after(async () => {
  server.close();
  await rm(work, { recursive: true, force: true });
});

describe("presets", () => {
  it("import-cycles lists only the files that import each other, edges highlighted", async () => {
    const body = await get("/api/graph/preset?name=import-cycles");
    assert.deepEqual(body.nodes.map((n: any) => n.name).sort(), ["a.ts", "b.ts", "c.ts"]);
    assert.equal(body.edges.length, 3);
    assert.ok(body.edges.every((e: any) => e.highlight === true && e.kind === "imports"));
    assert.match(body.note, /1 groups/);
  });

  it("routes-handlers-tables and requests-routes answer, with routes and handlers", async () => {
    const routes = await get("/api/graph/preset?name=routes-handlers-tables");
    assert.ok(routes.nodes.some((n: any) => n.label === "Route"));
    assert.ok(routes.nodes.some((n: any) => n.label === "Function"));
    const requests = await get("/api/graph/preset?name=requests-routes");
    assert.deepEqual(requests.nodes, []); // the fixture has no frontend requests
    assert.equal(requests.truncated, false);
  });

  it("component-tree answers and unknown presets are rejected", async () => {
    assert.deepEqual((await get("/api/graph/preset?name=component-tree")).nodes, []);
    await get("/api/graph/preset?name=nope", 400);
  });
});

describe("POST /api/query", () => {
  it("runs a read-only Cypher query", async () => {
    const response = await post({ project, query: "MATCH (r:Route) RETURN r.method AS method, r.path AS path ORDER BY path LIMIT 5" });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.columns, ["method", "path"]);
    assert.ok(body.rows.length > 0);
    assert.equal(body.truncated, false);
  });

  it("caps rows", async () => {
    const body = await (await post({ project, query: "MATCH (n:Call) RETURN n.name AS name" })).json();
    assert.ok(body.total >= body.rows.length);
    assert.ok(body.rows.length <= 1000);
  });

  it("refuses writes and bad input", async () => {
    const write = await post({ project, query: "CREATE (n:Function {name: 'x'})" });
    assert.equal(write.status, 400);
    assert.match((await write.json()).error, /Unsupported Cypher feature/);
    assert.equal((await post({ project, query: "MATCH (n RETURN n" })).status, 400);
    assert.equal((await post({ project })).status, 400);
    assert.equal((await post({ query: "MATCH (n) RETURN n" })).status, 400);
    const noGraph = await post({ project: work, query: "MATCH (n) RETURN n" });
    assert.equal(noGraph.status, 400);
    assert.match((await noGraph.json()).error, /scan the project first/);
  });

  it("needs the token", async () => {
    const response = await fetch(`${base}/api/query`, { method: "POST", body: JSON.stringify({ project, query: "MATCH (n) RETURN n" }) });
    assert.equal(response.status, 401);
  });
});

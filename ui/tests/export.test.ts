import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createUiServer } from "../server/index.js";
import { dotString } from "../server/export/dot.js";
import { escapeXml } from "../server/export/xml.js";

const TOKEN = "t";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", "..");
const GOLDEN = path.join(HERE, "golden");
let server: ReturnType<typeof createUiServer>;
let base: string;
let work: string;
let project: string;
const auth = { "x-concentrate-token": TOKEN };

const exportUrl = (query: string) => `${base}/api/export?project=${encodeURIComponent(project)}&${query}`;
async function download(query: string) {
  const response = await fetch(exportUrl(query), { headers: auth });
  assert.equal(response.status, 200, await response.clone().text());
  return response;
}
// Absolute paths differ per machine; goldens carry a placeholder.
const normalize = (text: string) => text.split(project).join("<root>");

async function assertGolden(name: string, actual: string) {
  const file = path.join(GOLDEN, name);
  if (process.env.UPDATE_GOLDEN === "1") {
    await mkdir(GOLDEN, { recursive: true });
    await writeFile(file, actual);
    return;
  }
  assert.equal(actual, await readFile(file, "utf8"), `${name} differs; run UPDATE_GOLDEN=1 npm test and review the diff`);
}

// Reads the stored entries of a zip written by our writer.
function unzip(buffer: Buffer): Record<string, string> {
  const files: Record<string, string> = {};
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const name = buffer.toString("utf8", offset + 30, offset + 30 + nameLength);
    files[name] = buffer.toString("utf8", offset + 30 + nameLength, offset + 30 + nameLength + size);
    offset += 30 + nameLength + size;
  }
  return files;
}

before(async () => {
  server = createUiServer(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await realpath(await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-export-")));
  project = path.join(work, "project");
  await cp(path.join(ROOT, "fixtures", "call-graph"), project, { recursive: true });
  // A name with every character the XML and DOT writers must escape.
  await writeFile(path.join(project, "odd.ts"), `export function weird() { return 1; }\nexport const odd = "a<b>&é";\n`);
  const scan = await fetch(`${base}/api/scan`, { method: "POST", headers: auth, body: JSON.stringify({ path: project }) });
  assert.match(await scan.text(), /event: done/);
});
after(async () => {
  server.close();
  await rm(work, { recursive: true, force: true });
});

describe("export formats", () => {
  it("rejects unknown formats and scopes", async () => {
    assert.equal((await fetch(exportUrl("format=png"), { headers: auth })).status, 400);
    assert.equal((await fetch(exportUrl("format=json&scope=nope"), { headers: auth })).status, 400);
    assert.equal((await fetch(`${base}/api/export?project=x&format=json`)).status, 401);
  });

  it("JSON: schema version, root path, nodes and relationships (golden)", async () => {
    const response = await download("format=json");
    assert.match(response.headers.get("content-disposition") ?? "", /attachment; filename=".*\.json"/);
    const text = await response.text();
    const body = JSON.parse(text);
    assert.equal(typeof body.schemaVersion, "number");
    assert.equal(body.rootPath, project);
    assert.ok(body.nodes.length > 0 && body.relationships.length > 0);
    await assertGolden("graph.json", normalize(text));
  });

  it("JSONL: the files of `concentrate export`", async () => {
    const response = await download("format=jsonl");
    assert.equal(response.headers.get("content-type"), "application/zip");
    const files = unzip(Buffer.from(await response.arrayBuffer()));
    assert.deepEqual(Object.keys(files).sort(), ["nodes.jsonl", "relationships.jsonl", "summary.json"]);

    const cliOut = path.join(work, "cli");
    execFileSync("npx", ["tsx", path.join(ROOT, "src", "index.ts"), "export", project, "-o", cliOut, "--no-cache"], { cwd: ROOT, stdio: "pipe" });
    for (const name of ["nodes.jsonl", "relationships.jsonl"]) {
      const cli = await readFile(path.join(cliOut, name), "utf8");
      assert.equal(files[name], cli, `${name} equals the CLI export byte for byte`);
    }
    const summary = JSON.parse(files["summary.json"]!);
    assert.equal(summary.nodes, files["nodes.jsonl"]!.trim().split("\n").length);
  });

  it("JSONL of a view comes from the store and has the view's counts", async () => {
    const files = unzip(Buffer.from(await (await download("format=jsonl&scope=view")).arrayBuffer()));
    const summary = JSON.parse(files["summary.json"]!);
    assert.equal(summary.nodes, files["nodes.jsonl"]!.trim().split("\n").length);
  });

  it("GraphML: well formed, typed keys, escaped (golden)", async () => {
    const text = await (await download("format=graphml")).text();
    assert.match(text, /<graphml xmlns="http:\/\/graphml\.graphdrawing\.org\/xmlns">/);
    assert.match(text, /<key id="n_line" for="node" attr\.name="line" attr\.type="long"\/>/);
    assert.match(text, /<key id="n_isExported" for="node" attr\.name="isExported" attr\.type="boolean"\/>/);
    assert.ok(text.includes("a&lt;b&gt;&amp;"), "special characters are escaped");
    assert.ok(!/<data[^>]*>[^<]*[<&](?!lt;|gt;|amp;|quot;|apos;)/.test(text.replace(/<\/?[a-z]+[^>]*>/g, "")), "no raw & left");
    assert.ok(text.includes("é"), "non-ASCII stays as UTF-8");
    await assertGolden("graph.graphml", normalize(text));
  });

  it("DOT: labels and types as attributes (golden)", async () => {
    const text = await (await download("format=dot")).text();
    assert.match(text, /^digraph concentrate \{/);
    assert.match(text, /-> .* \[label="CALLS", type="CALLS"\]/);
    await assertGolden("graph.dot", normalize(text));
  });

  it("escaping helpers", () => {
    assert.equal(escapeXml(`a<b>&"'`), "a&lt;b&gt;&amp;&quot;&apos;");
    assert.equal(escapeXml("x\u0001y"), "xy");
    assert.equal(dotString('a"b\\c\nd'), '"a\\"b\\\\c\\nd"');
  });

  it("HTML: one file, data inlined, nothing fetched from the network", async () => {
    const text = await (await download("format=html")).text();
    assert.match(text, /<script id="graph-data" type="application\/json">/);
    assert.ok(!/\s(src|href)\s*=\s*["']?(https?:)?\/\//i.test(text), "no external src or href");
    assert.ok(!/<link\b/i.test(text));
    assert.ok(!/\b(fetch|XMLHttpRequest|import\()/.test(text.replace(/<script id="graph-data"[\s\S]*?<\/script>/, "")), "viewer makes no requests");
    const data = JSON.parse(/<script id="graph-data" type="application\/json">([\s\S]*?)<\/script>/.exec(text)![1]!);
    assert.ok(data.nodes.some((n: { n: string }) => n.n === "weird"));
    assert.equal(data.notice, "");
  });

  it("scope=view exports the file level or a focus, filtered by kind", async () => {
    const view = JSON.parse(await (await download("format=json&scope=view")).text());
    assert.ok(view.nodes.every((n: { label: string }) => n.label === "File"));
    const overview = await (await fetch(`${base}/api/graph/overview?project=${encodeURIComponent(project)}&level=file`, { headers: auth })).json();
    assert.equal(view.nodes.length, overview.nodes.length);

    const search = await (await fetch(`${base}/api/search?project=${encodeURIComponent(project)}&q=outer`, { headers: auth })).json();
    const focus = JSON.parse(await (await download(`format=json&scope=view&focus=${encodeURIComponent(search.results[0].id)}&types=calls,defines`)).text());
    assert.ok(focus.nodes.some((n: { id: string }) => n.id === search.results[0].id));
    assert.ok(focus.relationships.every((r: { type: string }) => ["CALLS", "DEFINES_FUNCTION", "DEFINES_METHOD", "DEFINES_CLASS", "DEFINES_VARIABLE", "DEFINES_INTERFACE", "DEFINES_TYPE_ALIAS", "DEFINES_ENUM", "DEFINES"].includes(r.type)));
  });
});

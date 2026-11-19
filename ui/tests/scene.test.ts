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

type Item = { type: "cluster" | "node"; id: string; path?: string; parent: string; nodes?: number; direct?: number; children?: number; degree?: number };
type Scene = { items: Item[]; edges: Array<{ from: string; to: string; count: number; kind: string }>; total: number; isolated: number; hidden: Record<string, number> };

const scene = async (open: string[], extra = ""): Promise<Scene> => {
  const query = [...open.map((o) => `open=${encodeURIComponent(o)}`), `project=${encodeURIComponent(project)}`, extra].filter(Boolean).join("&");
  const response = await fetch(`${base}/api/graph/scene?${query}`, { headers: auth });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
};
/** Nodes the items stand for: a cluster counts all of its nodes. */
const covered = (s: Scene) => s.items.reduce((n, i) => n + (i.type === "cluster" ? i.nodes! : 1), 0) + Object.values(s.hidden).reduce((a, b) => a + b, 0);
const edgeTotal = (s: Scene) => s.edges.reduce((n, e) => n + e.count, 0);

before(async () => {
  server = createUiServer(TOKEN);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  work = await realpath(await mkdtemp(path.join(os.tmpdir(), "concentrate-ui-scene-")));
  project = path.join(work, "project");
  await cp(path.join(ROOT, "fixtures", "angular-components"), project, { recursive: true });
  const scan = await fetch(`${base}/api/scan`, { method: "POST", headers: auth, body: JSON.stringify({ path: project }) });
  assert.match(await scan.text(), /event: done/);
});
after(async () => {
  server.close();
  await rm(work, { recursive: true, force: true });
});

describe("GET /api/graph/scene", () => {
  it("shows the top folders as clusters that together hold every connected node", async () => {
    const s = await scene([]);
    assert.ok(s.total > 0);
    assert.equal(covered(s), s.total);
    const src = s.items.find((i) => i.id === "dir:src");
    assert.ok(src && src.type === "cluster", "src is a cluster");
    assert.equal(src.parent, "dir:");
    assert.ok(src.children! >= 2, "src has app and legacy below it");
    assert.equal(s.items.filter((i) => i.type === "cluster" && i.path!.includes("/")).length, 0, "nothing deeper than the top level");
  });

  it("opens a folder into its subfolders and its own nodes, keeping every node and every relationship", async () => {
    const closed = await scene([]);
    const open = await scene(["src", "src/app"]);
    assert.equal(covered(open), open.total);
    assert.ok(open.items.some((i) => i.id === "dir:src/legacy" && i.type === "cluster"));
    assert.ok(open.items.some((i) => i.id === "dir:src/app/shared" && i.parent === "dir:src/app"));
    const leaves = open.items.filter((i) => i.type === "node");
    assert.ok(leaves.some((l) => l.parent === "dir:src/app"), "src/app shows its own nodes");
    assert.ok(leaves.every((l) => ["dir:", "dir:src", "dir:src/app"].includes(l.parent)), "only open folders show nodes");
    const ids = new Set(open.items.map((i) => i.id));
    for (const edge of open.edges) assert.ok(ids.has(edge.from) && ids.has(edge.to) && edge.from !== edge.to, "edges join items");
    // Opening adds relationships that were inside a cluster, it never loses one between clusters.
    assert.ok(edgeTotal(open) >= edgeTotal(closed));
  });

  it("keeps the most connected nodes of an open folder and counts the rest", async () => {
    const all = await scene(["src", "src/app"]);
    const inApp = (s: Scene) => s.items.filter((i) => i.type === "node" && i.parent === "dir:src/app");
    const leaves = inApp(all).length;
    assert.ok(leaves > 2);
    const cut = await scene(["src", "src/app"], "limit=2");
    assert.equal(inApp(cut).length, 2);
    assert.equal(cut.hidden["dir:src/app"], leaves - 2);
    assert.equal(covered(cut), cut.total);
    const top = inApp(all).sort((a, b) => b.degree! - a.degree!)[0]!;
    assert.ok(cut.items.some((i) => i.id === top.id), "the most connected node stays");
  });

  it("follows the relationship kinds", async () => {
    const all = await scene(["src", "src/app"]);
    const imports = await scene(["src", "src/app"], "types=imports");
    assert.ok(imports.total <= all.total);
    assert.ok(imports.edges.every((e) => e.kind === "imports"));
  });
});

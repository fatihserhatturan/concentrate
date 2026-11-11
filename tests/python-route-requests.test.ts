import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

// Flask and Django write route parameters as <slug> and <int:id>; a frontend
// call with a ${…} segment reaches them like it reaches :slug, [slug] and {slug}.
describe("frontend requests to Flask and Django routes", () => {
  it("links a template URL to <param>, <int:param> and <path:rest> routes", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-py-requests-"));
    await mkdir(path.join(dir, "server"));
    await mkdir(path.join(dir, "web"));
    await writeFile(path.join(dir, "server", "app.py"), [
      "from flask import Flask",
      "app = Flask(__name__)",
      "",
      "@app.route('/api/items/<slug>', methods=('GET',))",
      "def get_item(slug):",
      "    return slug",
      "",
      "@app.route('/api/items/<int:item_id>/comments', methods=('POST',))",
      "def add_comment(item_id):",
      "    return ''",
      "",
      "@app.route('/files/<path:rest>', methods=('GET',))",
      "def get_file(rest):",
      "    return rest",
      "",
    ].join("\n"));
    await writeFile(path.join(dir, "web", "api.ts"), [
      "export const item = (slug: string) => fetch(`/api/items/${slug}`);",
      "export const comment = (id: number) => fetch(`/api/items/${id}/comments`, { method: \"POST\" });",
      "export const file = (name: string) => fetch(`/files/${name}`);",
      "export const nested = () => fetch(\"/files/a/b/c\");",
      "",
    ].join("\n"));
    const graph = await buildCodeGraph(dir, { continueOnError: false });
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const links = graph.relationships
      .filter((rel) => rel.type === "REQUESTS")
      .map((rel) => `${byId.get(rel.from)?.properties.line} -> ${String(byId.get(rel.to)?.properties.method).toUpperCase()} ${byId.get(rel.to)?.properties.fullPath}`)
      .sort();
    assert.deepEqual(links, [
      "1 -> GET /api/items/<slug>",
      "2 -> POST /api/items/<int:item_id>/comments",
      "3 -> GET /files/<path:rest>",
      "4 -> GET /files/<path:rest>",
    ]);
  });
});

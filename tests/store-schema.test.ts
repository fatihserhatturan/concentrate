import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { GraphStore } from "../src/adapters/store/store.js";
import { defaultGraphSchema } from "../src/composition/default-schema.js";
import { openGraphStore } from "../src/composition/graph-store.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { mergeGraphSchema, type GraphSchema } from "../src/core/graph/schema.js";
import { openTestStore } from "./helpers/store.js";

const widgets: GraphSchema = mergeGraphSchema(defaultGraphSchema, [
  {
    id: "widgets",
    nodeTables: [{ label: "Widget", properties: { name: "STRING", size: "INT64" } }],
    relationshipTables: [{ type: "FILE_HAS_WIDGET", from: "File", to: "Widget", properties: { note: "STRING" } }],
    nodeProperties: [{ label: "Function", properties: { owner: "STRING" } }],
  },
]);

const file = { id: "file:a.ts", label: "File", properties: { relativePath: "a.ts" } } as GraphNode;
const widget = (name: string) => ({ id: `file:a.ts:widget:${name}`, label: "Widget", properties: { name, size: 3 } }) as unknown as GraphNode;
const has = (name: string) => ({ from: "file:a.ts", to: `file:a.ts:widget:${name}`, type: "FILE_HAS_WIDGET", properties: { note: "n" } }) as unknown as GraphRelationship;

const freshDirectory = async () => path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-store-schema-")), "graph");

async function writeWidgets(directory: string, schema: GraphSchema, names: string[], reset: boolean): Promise<void> {
  const store = await openTestStore(directory, { schema });
  if (reset) await store.reset();
  await store.write(reset ? [file, ...names.map(widget)] : names.map(widget), names.map(has));
  await store.close();
}

describe("store with an injected schema", () => {
  it("accepts a new label, relationship and extension property, and rejects unknown ones", async () => {
    const directory = await freshDirectory();
    const store = await openTestStore(directory, { schema: widgets });
    await store.reset();
    await store.write(
      [file, widget("w"), { id: "file:a.ts:function:run", label: "Function", properties: { name: "run", owner: "me" } } as GraphNode],
      [has("w")],
    );
    assert.deepEqual(await store.query("MATCH (f:File)-[r:FILE_HAS_WIDGET]->(w:Widget) RETURN f.relativePath AS file, w.name AS name, w.size AS size, r.note AS note"), [
      { file: "a.ts", name: "w", size: 3, note: "n" },
    ]);
    assert.deepEqual(await store.query("MATCH (fn:Function) RETURN fn.owner AS owner"), [{ owner: "me" }]);
    assert.deepEqual((await store.stats()).find((row) => row.table === "Widget"), { table: "Widget", count: 1 });
    assert.equal((await store.stats()).at(-1)?.table, "Widget");

    await assert.rejects(store.write([{ id: "x", label: "Gadget", properties: {} } as unknown as GraphNode], []), /table Gadget does not exist/);
    await assert.rejects(store.write([{ id: "y", label: "Widget", properties: { weight: 1 } } as unknown as GraphNode], []), /unknown property weight/);
    await assert.rejects(store.query("MATCH (g:Gadget) RETURN g"), /Table Gadget does not exist/);
    await assert.rejects(store.query("MATCH (w:Widget) RETURN w.weight"), /Cannot find property weight/);
    await store.close();
  });

  it("does not know the extension without it", async () => {
    const store = await openTestStore(await freshDirectory());
    await store.reset();
    await assert.rejects(store.write([widget("w")], []), /table Widget does not exist/);
    await assert.rejects(store.query("MATCH (w:Widget) RETURN w"), /Table Widget does not exist/);
    const opened = await openGraphStore(await freshDirectory(), { schema: widgets });
    await opened.reset();
    await opened.write([file, widget("w")], [has("w")]);
    assert.deepEqual(await opened.query("MATCH (w:Widget) RETURN w.name AS name"), [{ name: "w" }]);
    await opened.close();
  });

  it("returns node properties in the schema's order", async () => {
    const directory = await freshDirectory();
    const store = await openTestStore(directory, { schema: widgets });
    await store.reset();
    await store.write([widget("w")], []);
    const [row] = await store.query("MATCH (w:Widget) RETURN w");
    assert.deepEqual(Object.keys((row as { w: object }).w), ["_label", "id", "name", "size"]);
    await store.close();
  });
});

describe("schema fingerprint", () => {
  it("is written to HEAD next to the version", async () => {
    const directory = await freshDirectory();
    await writeWidgets(directory, widgets, ["w"], true);
    const head = JSON.parse(await readFile(path.join(directory, "HEAD.json"), "utf8"));
    assert.equal(head.schemaVersion, widgets.version);
    assert.match(head.schemaFingerprint, /^[0-9a-f]{32}$/);
    const other = await freshDirectory();
    await writeWidgets(other, defaultGraphSchema, [], true);
    assert.notEqual(JSON.parse(await readFile(path.join(other, "HEAD.json"), "utf8")).schemaFingerprint, head.schemaFingerprint);
  });

  it("reuses the snapshot of the same schema", async () => {
    const directory = await freshDirectory();
    await writeWidgets(directory, widgets, ["one"], true);
    await writeWidgets(directory, widgets, ["two"], false);
    const store = await openTestStore(directory, { schema: widgets });
    assert.deepEqual(await store.query("MATCH (w:Widget) RETURN w.name AS name ORDER BY name"), [{ name: "one" }, { name: "two" }]);
    await store.close();
  });

  it("rewrites instead of patching a snapshot written for another schema", async () => {
    const directory = await freshDirectory();
    await writeWidgets(directory, widgets, ["old"], true);
    const before = JSON.parse(await readFile(path.join(directory, "HEAD.json"), "utf8"));

    // Same data model plus a property: a different schema, so the old snapshot is not patched.
    const extended = mergeGraphSchema(widgets, [{ id: "more", nodeProperties: [{ label: "Widget", properties: { weight: "INT64" } }] }]);
    const store = await openTestStore(directory, { schema: extended });
    await store.write([widget("new")], []);
    assert.deepEqual(await store.query("MATCH (w:Widget) RETURN w.name AS name"), [{ name: "new" }]);
    await store.close();

    const after = JSON.parse(await readFile(path.join(directory, "HEAD.json"), "utf8"));
    assert.equal(after.generation, before.generation + 1);
    assert.notEqual(after.schemaFingerprint, before.schemaFingerprint);

    // Now the store matches again and its snapshot is reused.
    const again = await openTestStore(directory, { schema: extended });
    await again.write([widget("newer")], []);
    assert.deepEqual(await again.query("MATCH (w:Widget) RETURN w.name AS name ORDER BY name"), [{ name: "new" }, { name: "newer" }]);
    await again.close();
  });

  it("does not trust a head without a fingerprint, and says what to do when reading a snapshot of other tables", async () => {
    const directory = await freshDirectory();
    await writeWidgets(directory, widgets, ["old"], true);

    const reader = await openTestStore(directory);
    await assert.rejects(reader.query("MATCH (w:Widget) RETURN w"), /was written for another graph schema .*run concentrate scan again/);
    await reader.close();

    const headPath = path.join(directory, "HEAD.json");
    const head = JSON.parse(await readFile(headPath, "utf8"));
    delete head.schemaFingerprint;
    await writeFile(headPath, JSON.stringify(head));
    const legacy = await openTestStore(directory, { schema: widgets });
    await legacy.write([widget("fresh")], []);
    assert.deepEqual(await legacy.query("MATCH (w:Widget) RETURN w.name AS name"), [{ name: "fresh" }]);
    await legacy.close();
  });
});

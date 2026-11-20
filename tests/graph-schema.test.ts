import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { createDefaultCoreIntegrationRegistry } from "../src/composition/default-registry.js";
import { defaultGraphSchema } from "../src/composition/default-schema.js";
import { CoreIntegrationRegistry } from "../src/core/integrations/registry.js";
import {
  baseGraphSchema,
  indexGraphSchema,
  mergeGraphSchema,
  type GraphSchema,
  type GraphSchemaExtension,
} from "../src/core/graph/schema.js";

const small: GraphSchema = {
  version: 1,
  nodeTables: [
    { label: "A", properties: { name: "STRING", line: "INT64", flag: "BOOLEAN" } },
    { label: "B", properties: { name: "STRING" } },
  ],
  relationshipTables: [{ type: "A_TO_B", from: "A", to: "B", properties: { line: "INT64" } }],
  nodeLabels: ["A", "B"],
};

function merge(...extensions: GraphSchemaExtension[]): GraphSchema {
  return mergeGraphSchema(small, extensions);
}

const names = (properties: Readonly<Record<string, string>>) => Object.keys(properties);

describe("mergeGraphSchema", () => {
  it("returns the base unchanged without extensions and does not mutate its input", () => {
    const before = JSON.stringify(small);
    assert.deepEqual(merge(), small);
    merge({ id: "x", nodeProperties: [{ label: "A", properties: { extra: "STRING" } }] });
    assert.equal(JSON.stringify(small), before);
  });

  it("adds node tables, appends their labels to the stats order and adds relationship tables", () => {
    const merged = merge({
      id: "widgets",
      nodeTables: [{ label: "Widget", properties: { size: "INT64" } }],
      relationshipTables: [{ type: "A_HAS_WIDGET", from: "A", to: "Widget", properties: { role: "STRING" } }],
    });
    assert.deepEqual(merged.nodeTables.map((table) => table.label), ["A", "B", "Widget"]);
    assert.deepEqual(merged.nodeLabels, ["A", "B", "Widget"]);
    assert.deepEqual(merged.relationshipTables.map((table) => table.type), ["A_TO_B", "A_HAS_WIDGET"]);
    assert.deepEqual(merged.relationshipTables[1], { type: "A_HAS_WIDGET", from: "A", to: "Widget", properties: { role: "STRING" } });
  });

  it("adds properties to existing tables at the end or after an anchor, keeping groups together", () => {
    const merged = merge(
      { id: "one", nodeProperties: [{ label: "A", after: "name", properties: { x: "STRING", y: "INT64" } }, { label: "B", properties: { tail: "BOOLEAN" } }] },
      { id: "two", nodeProperties: [{ label: "A", after: "name", properties: { z: "STRING" } }, { label: "A", after: "nope", properties: { end: "STRING" } }] },
      { id: "three", relationshipProperties: [{ label: "A_TO_B", properties: { note: "STRING" } }] },
    );
    assert.deepEqual(names(merged.nodeTables[0]!.properties), ["name", "x", "y", "z", "line", "flag", "end"]);
    assert.deepEqual(names(merged.nodeTables[1]!.properties), ["name", "tail"]);
    assert.deepEqual(merged.relationshipTables[0]!.properties, { line: "INT64", note: "STRING" });
  });

  it("can extend a table another extension adds", () => {
    const merged = merge(
      { id: "one", nodeTables: [{ label: "Widget", properties: { size: "INT64" } }] },
      { id: "two", nodeProperties: [{ label: "Widget", properties: { color: "STRING" } }] },
    );
    assert.deepEqual(merged.nodeTables[2]!.properties, { size: "INT64", color: "STRING" });
  });

  it("accepts a table or property declared again with the same type", () => {
    const merged = merge(
      { id: "one", nodeTables: [{ label: "Widget", properties: { size: "INT64" } }], nodeProperties: [{ label: "A", properties: { name: "STRING" } }] },
      { id: "two", nodeTables: [{ label: "Widget", properties: { size: "INT64", color: "STRING" } }], relationshipTables: [{ type: "A_TO_B", from: "A", to: "B", properties: { line: "INT64" } }] },
    );
    assert.deepEqual(merged.nodeTables.map((table) => table.label), ["A", "B", "Widget"]);
    assert.deepEqual(merged.nodeTables[2]!.properties, { size: "INT64", color: "STRING" });
    assert.deepEqual(merged.nodeTables[0], small.nodeTables[0]);
    assert.equal(merged.relationshipTables.length, 1);
  });

  it("rejects conflicting property types, naming the extension", () => {
    assert.throws(() => merge({ id: "bad", nodeProperties: [{ label: "A", properties: { name: "INT64" } }] }), /extension "bad": node table A property name is INT64 but already declared as STRING/);
    assert.throws(() => merge({ id: "bad", nodeTables: [{ label: "B", properties: { name: "BOOLEAN" } }] }), /extension "bad": node table B property name is BOOLEAN/);
    assert.throws(() => merge({ id: "bad", relationshipProperties: [{ label: "A_TO_B", properties: { line: "STRING" } }] }), /relationship table A_TO_B property line/);
    assert.throws(
      () => merge({ id: "one", nodeTables: [{ label: "W", properties: { p: "STRING" } }] }, { id: "two", nodeProperties: [{ label: "W", properties: { p: "INT64" } }] }),
      /extension "two": node table W property p is INT64 but already declared as STRING/,
    );
  });

  it("rejects relationship tables that disagree on endpoints and unknown tables or endpoints", () => {
    assert.throws(() => merge({ id: "bad", relationshipTables: [{ type: "A_TO_B", from: "B", to: "A", properties: {} }] }), /A_TO_B is B -> A but already exists as A -> B/);
    assert.throws(() => merge({ id: "bad", nodeProperties: [{ label: "Nope", properties: { p: "STRING" } }] }), /unknown node table Nope/);
    assert.throws(() => merge({ id: "bad", relationshipProperties: [{ label: "NOPE", properties: { p: "STRING" } }] }), /unknown relationship table NOPE/);
    assert.throws(() => merge({ id: "bad", relationshipTables: [{ type: "X", from: "A", to: "Missing", properties: {} }] }), /relationship table X refers to unknown node table Missing/);
  });

  it("rejects a node property named id and unknown property types", () => {
    assert.throws(() => merge({ id: "bad", nodeTables: [{ label: "W", properties: { id: "STRING" } }] }), /cannot declare a property named id/);
    assert.throws(() => merge({ id: "bad", nodeProperties: [{ label: "A", properties: { p: "FLOAT" as never } }] }), /unknown type "FLOAT"/);
  });

  it("indexes a schema for lookups", () => {
    const index = indexGraphSchema(merge({ id: "w", nodeTables: [{ label: "Widget", properties: {} }] }));
    assert.equal(index.nodeTableByLabel.get("Widget")?.label, "Widget");
    assert.equal(index.relationshipTableByType.get("A_TO_B")?.from, "A");
    assert.deepEqual(index.relationshipTypes, ["A_TO_B"]);
  });
});

describe("registry graph schema", () => {
  it("merges registered extensions, rejects duplicate ids and conflicts, and keeps the schema after a rejection", () => {
    const registry = new CoreIntegrationRegistry();
    assert.equal(registry.graphSchema, baseGraphSchema);
    registry.registerGraphSchema({ id: "w", nodeTables: [{ label: "Widget", properties: { size: "INT64" } }] });
    assert.ok(registry.graphSchema.nodeTables.some((table) => table.label === "Widget"));
    assert.throws(() => registry.registerGraphSchema({ id: "w" }), /already registered: w/);
    assert.throws(() => registry.registerGraphSchema({ id: "c", nodeProperties: [{ label: "Widget", properties: { size: "STRING" } }] }), /extension "c"/);
    assert.deepEqual(registry.graphSchema.nodeTables.find((table) => table.label === "Widget")?.properties, { size: "INT64" });
    registry.registerGraphSchema({ id: "ok", nodeProperties: [{ label: "Widget", properties: { color: "STRING" } }] });
    assert.deepEqual(registry.graphSchema.nodeTables.find((table) => table.label === "Widget")?.properties, { size: "INT64", color: "STRING" });
  });
});

describe("default graph schema", () => {
  it("equals the frozen snapshot of the closed schema: no table, property, type, order or label lost", async () => {
    const snapshot = JSON.parse(await readFile(path.join(import.meta.dirname, "fixtures/graph-schema.snapshot.json"), "utf8")) as GraphSchema;
    const actual = createDefaultCoreIntegrationRegistry().graphSchema;
    assert.deepEqual(actual, snapshot);
    // deepEqual ignores key order; the order of tables and properties shows in query results, so compare it too.
    assert.equal(JSON.stringify(actual), JSON.stringify(snapshot));
    assert.deepEqual(defaultGraphSchema, snapshot);
  });

  it("is the base schema plus extensions only: extensions add properties, and Java adds its relationship tables", () => {
    assert.deepEqual(defaultGraphSchema.nodeTables.map((table) => table.label), baseGraphSchema.nodeTables.map((table) => table.label));
    assert.deepEqual(defaultGraphSchema.relationshipTables.map((table) => table.type), [
      ...baseGraphSchema.relationshipTables.map((table) => table.type),
      "DEFINES_INTERFACE_METHOD",
      "DEFINES_INTERFACE_FIELD",
      "FIELD_HAS_DECORATOR",
    ]);
    assert.deepEqual(defaultGraphSchema.nodeLabels, baseGraphSchema.nodeLabels);
    assert.ok(Object.keys(defaultGraphSchema.nodeTables.find((table) => table.label === "File")!.properties).includes("rustCrate"));
    assert.ok(!Object.keys(baseGraphSchema.nodeTables.find((table) => table.label === "File")!.properties).includes("rustCrate"));
  });

  it("lists every node table in graph_stats", () => {
    assert.deepEqual([...defaultGraphSchema.nodeLabels].sort(), defaultGraphSchema.nodeTables.map((table) => table.label).sort());
  });
});

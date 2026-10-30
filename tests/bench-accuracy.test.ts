import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { samplesDirectory } from "../src/adapters/cli/smoke.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import {
  compareCalls,
  compareComponents,
  compareDataAccess,
  compareRenders,
  compareRoutes,
  fileOfNodeId,
  normalizePath,
  type Labels,
} from "../scripts/accuracy/compare.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const node = (id: string, label: GraphNode["label"], properties: GraphNode["properties"]): GraphNode => ({ id, label, properties });
const rel = (from: string, type: GraphRelationship["type"], to: string, properties: GraphRelationship["properties"] = {}): GraphRelationship => ({ from, to, type, properties });
const files = (...paths: string[]) => paths.map((file) => node(`file:${file}`, "File", { relativePath: file }));

function routeGraph(routes: Array<{ file: string; method: string; path: string; fullPath?: string; line: number }>): Graph {
  const graph: Graph = { nodes: files(...new Set(routes.map((route) => route.file))), relationships: [] };
  routes.forEach((route, index) => {
    const id = `file:${route.file}:route:${index}`;
    graph.nodes.push(node(id, "Route", { method: route.method, path: route.path, ...(route.fullPath ? { fullPath: route.fullPath } : {}), line: route.line }));
    graph.relationships.push(rel(`file:${route.file}`, "DECLARES_ROUTE", id));
  });
  return graph;
}

describe("accuracy comparator: routes", () => {
  it("matches method, file and line ±1, ignores middleware mounts and files out of scope", () => {
    const graph = routeGraph([
      { file: "src/a.js", method: "get", path: "/users", line: 11 },
      { file: "src/a.js", method: "USE", path: "/api", line: 3 },
      { file: "src/a.js", method: "POST", path: "/extra", line: 20 },
      { file: "test/a.js", method: "GET", path: "/ignored", line: 1 },
    ]);
    const score = compareRoutes(graph, {
      scope: ["src/"],
      items: [
        { method: "GET", path: "/users/", file: "src/a.js", line: 10 },
        { method: "DELETE", path: "/users/:id", file: "src/a.js", line: 30 },
      ],
    });
    assert.deepEqual([score.tp, score.fp, score.fn], [1, 1, 1]);
    assert.deepEqual(score.falsePositives, ["POST /extra (src/a.js:20)"]);
    assert.deepEqual(score.falseNegatives, ["DELETE /users/:id (src/a.js:30)"]);
    assert.deepEqual(score.paths, { correct: 1, total: 1, wrong: [] });
  });

  it("scores a missed mount prefix as a wrong full path, not a missed route", () => {
    const graph = routeGraph([{ file: "r.ts", method: "GET", path: "/tags", line: 5 }]);
    const score = compareRoutes(graph, { scope: ["r.ts"], items: [{ method: "GET", path: "/api/tags", file: "r.ts", line: 5 }] });
    assert.deepEqual([score.tp, score.fp, score.fn], [1, 0, 0]);
    assert.deepEqual(score.paths, { correct: 0, total: 1, wrong: ["GET /api/tags (r.ts:5) found as /tags"] });
  });

  it("prefers the resolved full path", () => {
    const graph = routeGraph([{ file: "r.ts", method: "GET", path: "/tags", fullPath: "/api/tags", line: 5 }]);
    assert.equal(compareRoutes(graph, { scope: ["r.ts"], items: [{ method: "GET", path: "/api/tags", file: "r.ts", line: 5 }] }).paths.correct, 1);
  });

  it("normalizes duplicate and trailing slashes", () => {
    assert.equal(normalizePath("/api//users/"), "/api/users");
    assert.equal(normalizePath("/"), "/");
    assert.equal(normalizePath(""), "/");
  });
});

function callGraph(calls: Array<{ file: string; line: number; callee: string; target?: { file: string; name: string; className?: string; label?: GraphNode["label"] } }>): Graph {
  const graph: Graph = { nodes: files("a.ts", "b.ts"), relationships: [] };
  calls.forEach((call, index) => {
    const id = `file:${call.file}:function:1:main:call:${call.line}:${index}:${call.callee}`;
    graph.nodes.push(node(id, "Call", { callee: call.callee, line: call.line }));
    if (call.target) {
      const targetId = `file:${call.target.file}:${call.target.label ?? "function"}:${call.target.className ?? ""}:${call.target.name}`;
      if (!graph.nodes.some((entry) => entry.id === targetId)) {
        graph.nodes.push(node(targetId, call.target.label ?? "Function", { name: call.target.name, ...(call.target.className ? { className: call.target.className } : {}) }));
      }
      graph.relationships.push(rel(id, "CALL_RESOLVES_TO", targetId));
    }
  });
  return graph;
}

describe("accuracy comparator: calls", () => {
  const labels = (items: NonNullable<Labels["calls"]>["items"]) => ({ files: ["a.ts"], items });

  it("counts right, wrong, missing and unexpected resolutions", () => {
    const graph = callGraph([
      { file: "a.ts", line: 1, callee: "save", target: { file: "b.ts", name: "save" } },
      { file: "a.ts", line: 2, callee: "load", target: { file: "b.ts", name: "other" } },
      { file: "a.ts", line: 3, callee: "missing" },
      { file: "a.ts", line: 4, callee: "trim", target: { file: "b.ts", name: "trim" } },
      { file: "a.ts", line: 5, callee: "extra", target: { file: "b.ts", name: "extra" } },
      { file: "b.ts", line: 1, callee: "notLabeledFile", target: { file: "a.ts", name: "x" } },
    ]);
    const score = compareCalls(graph, labels([
      { file: "a.ts", line: 1, callee: "save", target: { file: "b.ts", name: "save" } },
      { file: "a.ts", line: 2, callee: "load", target: { file: "b.ts", name: "load" } },
      { file: "a.ts", line: 3, callee: "missing", target: { file: "b.ts", name: "missing" } },
      { file: "a.ts", line: 4, callee: "trim", target: null },
    ]));
    assert.equal(score.tp, 1);
    assert.deepEqual(score.falsePositives, [
      "a.ts:2 load -> b.ts other",
      "a.ts:4 trim -> b.ts trim",
      "a.ts:5 extra -> b.ts extra (call site not labeled)",
    ]);
    assert.deepEqual(score.falseNegatives, ["a.ts:2 load -> b.ts load", "a.ts:3 missing -> b.ts missing"]);
  });

  it("does not score dynamic call sites and keeps unresolved ones neutral", () => {
    const graph = callGraph([
      { file: "a.ts", line: 1, callee: "render", target: { file: "b.ts", name: "render" } },
      { file: "a.ts", line: 2, callee: "log" },
    ]);
    const score = compareCalls(graph, labels([
      { file: "a.ts", line: 1, callee: "render", target: null, dynamic: true },
      { file: "a.ts", line: 2, callee: "log", target: null },
    ]));
    assert.deepEqual([score.tp, score.fp, score.fn], [0, 0, 0]);
    assert.equal(score.precision, null);
  });

  it("matches a constructor label to the constructor or the class, and class methods by class", () => {
    const graph = callGraph([
      { file: "a.ts", line: 1, callee: "Err", target: { file: "b.ts", name: "Err", label: "Class" } },
      { file: "a.ts", line: 2, callee: "Err", target: { file: "b.ts", name: "constructor", className: "Err" } },
      { file: "a.ts", line: 3, callee: "create", target: { file: "b.ts", name: "create", className: "Other" } },
    ]);
    const ctor = { file: "b.ts", name: "constructor", className: "Err" };
    const score = compareCalls(graph, labels([
      { file: "a.ts", line: 1, callee: "Err", target: ctor },
      { file: "a.ts", line: 2, callee: "Err", target: ctor },
      { file: "a.ts", line: 3, callee: "create", target: { file: "b.ts", name: "create", className: "Ky" } },
    ]));
    assert.equal(score.tp, 2);
    assert.deepEqual(score.falseNegatives, ["a.ts:3 create -> b.ts Ky.create"]);
  });

  it("pairs same-named calls on adjacent lines by exact line first", () => {
    const graph = callGraph([
      { file: "a.ts", line: 10, callee: "go" },
      { file: "a.ts", line: 11, callee: "go", target: { file: "b.ts", name: "go" } },
    ]);
    const score = compareCalls(graph, labels([
      { file: "a.ts", line: 11, callee: "go", target: { file: "b.ts", name: "go" } },
      { file: "a.ts", line: 10, callee: "go", target: null },
    ]));
    assert.deepEqual([score.tp, score.fp, score.fn], [1, 0, 0]);
  });
});

describe("accuracy comparator: data access", () => {
  // `load` calls the repository itself; `handler` only reaches it through `load`.
  const fn = (name: string) => node(`file:s.ts:function:1:${name}`, "Function", { name });
  const graph: Graph = {
    nodes: [
      ...files("s.ts"),
      fn("load"),
      fn("handler"),
      node("file:s.ts:function:1:load:call:2:0:repo.find", "Call", { line: 2, expression: "repo.find" }),
      node("file:s.ts:function:1:load:call:3:0:repo.find", "Call", { line: 3, expression: "repo.find" }),
      node("datamodel:typeorm:s.ts:User", "DataModel", { name: "User" }),
      node("table:typeorm:s.ts:user", "Table", { name: "user" }),
    ],
    relationships: [
      rel("file:s.ts:function:1:load", "CALLS", "file:s.ts:function:1:load:call:2:0:repo.find"),
      rel("file:s.ts:function:1:load", "CALLS", "file:s.ts:function:1:load:call:3:0:repo.find"),
      rel("file:s.ts:function:1:load", "ACCESSES_DATA", "datamodel:typeorm:s.ts:User", { line: 2, expression: "repo.find", operation: "read" }),
      rel("file:s.ts:function:1:load", "ACCESSES_DATA", "datamodel:typeorm:s.ts:User", { line: 3, expression: "repo.find", operation: "read" }),
      rel("file:s.ts:function:1:handler", "ACCESSES_DATA", "datamodel:typeorm:s.ts:User", { line: 2, expression: "repo.find", operation: "read" }),
      rel("datamodel:typeorm:s.ts:User", "MAPS_TO_TABLE", "table:typeorm:s.ts:user"),
    ],
  };

  it("keeps direct accesses once per function, model and operation, and checks the table", () => {
    const score = compareDataAccess(graph, {
      scope: ["s.ts"],
      items: [
        { file: "s.ts", function: "load", model: "User", operation: "read", table: "user" },
        { file: "s.ts", function: "load", model: "User", operation: "delete" },
      ],
    });
    assert.deepEqual([score.tp, score.fp, score.fn], [1, 0, 1]);
    assert.deepEqual(score.falseNegatives, ["s.ts load: delete User"]);
  });

  it("counts a wrong table as a miss", () => {
    const score = compareDataAccess(graph, { scope: ["s.ts"], items: [{ file: "s.ts", function: "load", model: "User", operation: "read", table: "users" }] });
    assert.deepEqual([score.tp, score.fp, score.fn], [0, 1, 1]);
  });
});

it("finds the file of a node id", () => {
  const known = new Set(["src/a:b.ts", "src/a"]);
  assert.equal(fileOfNodeId("file:src/a:b.ts:function:1:f", known), "src/a:b.ts");
  assert.equal(fileOfNodeId("file:src/a", known), "src/a");
  assert.equal(fileOfNodeId("datamodel:x", known), null);
});

describe("accuracy comparator: components and renders", () => {
  // Card (a.tsx:3) renders Button (b.tsx:1) at line 5 and Icon at line 6;
  // Page (out/p.tsx) is out of scope.
  const graph: Graph = { nodes: files("src/a.tsx", "src/b.tsx", "out/p.tsx"), relationships: [] };
  const component = (file: string, name: string, line: number) => {
    const id = `file:${file}:component:${line}:${name}`;
    graph.nodes.push(node(id, "Component", { name, line }));
    graph.relationships.push(rel(`file:${file}`, "DECLARES_COMPONENT", id));
    return id;
  };
  const card = component("src/a.tsx", "Card", 3);
  const button = component("src/b.tsx", "Button", 1);
  const icon = component("src/b.tsx", "Icon", 9);
  const page = component("out/p.tsx", "Page", 1);
  graph.relationships.push(
    rel(card, "RENDERS", button, { line: 5, props: "label" }),
    rel(card, "RENDERS", icon, { line: 6, props: "" }),
    rel(page, "RENDERS", card, { line: 2, props: "" }),
  );

  it("matches components by file, name and line ±1 within scope", () => {
    const score = compareComponents(graph, {
      scope: ["src/"],
      items: [{ file: "src/a.tsx", name: "Card", line: 4 }, { file: "src/b.tsx", name: "Button", line: 1 }, { file: "src/b.tsx", name: "Badge", line: 20 }],
    });
    assert.deepEqual([score.tp, score.fp, score.fn], [2, 1, 1]);
    assert.deepEqual(score.falsePositives, ["src/b.tsx:9 Icon"]);
    assert.deepEqual(score.falseNegatives, ["src/b.tsx:20 Badge"]);
  });

  it("counts a render linked to the wrong component as a false positive and a false negative", () => {
    const score = compareRenders(graph, {
      scope: ["src/"],
      items: [
        { file: "src/a.tsx", parent: "Card", line: 5, child: "Button", childFile: "src/b.tsx" },
        { file: "src/a.tsx", parent: "Card", line: 6, child: "Badge", childFile: "src/b.tsx" },
      ],
    });
    assert.deepEqual([score.tp, score.fp, score.fn], [1, 1, 1]);
    assert.deepEqual(score.falsePositives, ["src/a.tsx:6 Card -> src/b.tsx Icon"]);
  });
});

describe("label files", () => {
  const labelsDirectory = path.join(import.meta.dirname, "../bench/labels");
  for (const labelFile of readdirSync(labelsDirectory).filter((file) => file.endsWith(".json"))) {
    const labels = JSON.parse(readFileSync(path.join(labelsDirectory, labelFile), "utf8")) as Labels;

    it(`${labelFile} has complete entries`, () => {
      assert.equal(labelFile, `${labels.sample}.json`);
      for (const route of labels.routes?.items ?? []) {
        assert.ok(route.method && route.path.startsWith("/") && route.file && Number.isInteger(route.line), JSON.stringify(route));
      }
      for (const call of labels.calls?.items ?? []) {
        assert.ok(call.file && call.callee && Number.isInteger(call.line) && call.target !== undefined, JSON.stringify(call));
        assert.ok(labels.calls!.files.includes(call.file), `${call.file} is not in calls.files`);
        if (call.target) assert.ok(call.target.file && call.target.name, JSON.stringify(call));
      }
      for (const access of labels.dataAccess?.items ?? []) {
        assert.ok(access.file && access.function && access.model && access.operation, JSON.stringify(access));
      }
      for (const component of labels.components?.items ?? []) {
        assert.ok(component.file && component.name && Number.isInteger(component.line), JSON.stringify(component));
      }
      for (const render of labels.renders?.items ?? []) {
        assert.ok(render.file && render.parent && render.child && render.childFile && Number.isInteger(render.line), JSON.stringify(render));
      }
    });

    const projectPath = path.join(samplesDirectory(), labels.sample);
    it(`${labelFile} names files that exist in the sample`, { skip: existsSync(projectPath) ? false : "sample not fetched" }, () => {
      const named = new Set([
        ...(labels.routes?.items ?? []).map((route) => route.file),
        ...(labels.calls?.files ?? []),
        ...(labels.calls?.items ?? []).flatMap((call) => (call.target ? [call.target.file] : [])),
        ...(labels.dataAccess?.items ?? []).map((access) => access.file),
        ...(labels.components?.items ?? []).map((component) => component.file),
        ...(labels.renders?.items ?? []).flatMap((render) => [render.file, render.childFile]),
      ]);
      for (const file of named) assert.ok(existsSync(path.join(projectPath, file)), `${file} is missing in ${labels.sample}`);
    });
  }
});

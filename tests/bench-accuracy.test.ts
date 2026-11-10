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
  compareEnvDeclarations,
  comparePages,
  compareRenders,
  compareRequests,
  compareRoutes,
  compareRuns,
  compareScripts,
  compareStoreAccess,
  compareStores,
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

  it("scores each target of a call that dispatches to several (interface implementers)", () => {
    const graph = callGraph([
      { file: "a.go", line: 1, callee: "Find", target: { file: "mysql.go", name: "Find", className: "Repo" } },
      { file: "b.ts", line: 1, callee: "unused", target: { file: "mock.go", name: "Find", className: "MockRepo" } },
      { file: "b.ts", line: 2, callee: "unused", target: { file: "other.go", name: "Find", className: "Other" } },
    ]);
    graph.nodes.push(...files("a.go", "mysql.go", "mock.go", "other.go", "pg.go"));
    const call = graph.nodes.find((entry) => entry.label === "Call" && entry.properties.callee === "Find")!;
    for (const target of graph.nodes.filter((entry) => entry.label === "Function" && entry.properties.className !== "Repo")) {
      graph.relationships.push(rel(call.id, "CALL_RESOLVES_TO", target.id));
    }
    const score = compareCalls(graph, { files: ["a.go"], items: [{
      file: "a.go", line: 1, callee: "Find", target: null,
      targets: [
        { file: "mysql.go", name: "Find", className: "Repo" },
        { file: "mock.go", name: "Find", className: "MockRepo" },
        { file: "pg.go", name: "Find", className: "PgRepo" },
      ],
    }] });
    assert.equal(score.tp, 2);
    assert.deepEqual(score.falsePositives, ["a.go:1 Find -> other.go Other.Find"]);
    assert.deepEqual(score.falseNegatives, ["a.go:1 Find -> pg.go PgRepo.Find"]);
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

describe("accuracy comparator: pages", () => {
  // app/page.tsx renders Home; app/about/page.tsx renders nothing.
  const graph: Graph = { nodes: files("app/page.tsx", "app/about/page.tsx"), relationships: [] };
  const page = (file: string, fullPath: string, kind: string) => {
    const id = `file:${file}:page`;
    graph.nodes.push(node(id, "Page", { fullPath, kind }));
    graph.relationships.push(rel(`file:${file}`, "DECLARES_PAGE", id));
    return id;
  };
  const home = page("app/page.tsx", "/", "page");
  page("app/about/page.tsx", "/about", "page");
  graph.nodes.push(node("file:app/page.tsx:component:1:Home", "Component", { name: "Home", line: 1 }));
  graph.relationships.push(rel(home, "PAGE_RENDERS", "file:app/page.tsx:component:1:Home"));

  it("matches pages by file, kind, full path and rendered component", () => {
    const score = comparePages(graph, {
      scope: ["app/"],
      items: [
        { file: "app/page.tsx", fullPath: "/", kind: "page", component: "Home" },
        { file: "app/about/page.tsx", fullPath: "/about", kind: "page", component: "About" },
      ],
    });
    assert.deepEqual([score.tp, score.fp, score.fn], [1, 1, 1]);
    assert.deepEqual(score.falsePositives, ["app/about/page.tsx page /about -> (none)"]);
    assert.deepEqual(score.falseNegatives, ["app/about/page.tsx page /about -> About"]);
  });
});

describe("accuracy comparator: requests", () => {
  // web/api.ts line 3 requests GET /api/users; line 7 requests the wrong route.
  const graph: Graph = { nodes: files("web/api.ts", "server/app.js"), relationships: [] };
  const route = (index: number, method: string, fullPath: string) => {
    const id = `file:server/app.js:route:${index}`;
    graph.nodes.push(node(id, "Route", { method, path: fullPath, fullPath, line: index }));
    graph.relationships.push(rel("file:server/app.js", "DECLARES_ROUTE", id));
    return id;
  };
  const users = route(1, "GET", "/api/users");
  const user = route(2, "GET", "/api/users/:id");
  const call = (line: number, to: string) => {
    const id = `file:web/api.ts:call:${line}:1:fetch`;
    graph.nodes.push(node(id, "Call", { line }));
    graph.relationships.push(rel(id, "REQUESTS", to));
  };
  call(3, users);
  call(7, user);

  it("matches a call's file, line ±1 and route with its declaring file", () => {
    const score = compareRequests(graph, {
      scope: ["web/"],
      items: [
        { file: "web/api.ts", line: 4, route: "GET /api/users", routeFile: "server/app.js" },
        { file: "web/api.ts", line: 7, route: "GET /api/users", routeFile: "server/app.js" },
        { file: "web/api.ts", line: 12, route: "POST /api/users", routeFile: "server/app.js" },
      ],
    });
    assert.deepEqual([score.tp, score.fp, score.fn], [1, 1, 2]);
    assert.deepEqual(score.falsePositives, ["web/api.ts:7 -> GET /api/users/:id (server/app.js)"]);
    assert.deepEqual(score.falseNegatives, [
      "web/api.ts:7 -> GET /api/users (server/app.js)",
      "web/api.ts:12 -> POST /api/users (server/app.js)",
    ]);
  });
});

describe("accuracy comparator: stores", () => {
  // src/store.ts declares the Pinia store cart; src/a.vue line 4 reads items
  // and writes add, line 9 only reads total.
  const graph: Graph = { nodes: files("src/store.ts", "src/a.vue"), relationships: [] };
  const cart = "file:src/store.ts:store:1:cart";
  const fn = "file:src/a.vue:function:1:<script setup>";
  graph.nodes.push(node(cart, "Store", { name: "cart", library: "pinia", kind: "setup" }));
  graph.relationships.push(
    rel("file:src/store.ts", "DECLARES_STORE", cart),
    rel(fn, "READS_STORE", cart, { line: 4, members: "items" }),
    rel(fn, "WRITES_STORE", cart, { line: 4, members: "add" }),
    rel(fn, "READS_STORE", cart, { line: 9, members: "total" }),
  );

  it("matches stores by file, name, library and kind", () => {
    const score = compareStores(graph, {
      scope: ["src/"],
      items: [{ file: "src/store.ts", name: "cart", library: "pinia", kind: "options" }],
    });
    assert.deepEqual([score.tp, score.fp, score.fn], [0, 1, 1]);
    assert.deepEqual(score.falsePositives, ["src/store.ts pinia setup cart"]);
  });

  it("matches a use by file, line ±1, store and the members read and written", () => {
    const score = compareStoreAccess(graph, {
      scope: ["src/"],
      items: [
        { file: "src/a.vue", line: 5, store: "cart", storeFile: "src/store.ts", reads: ["items"], writes: ["add"] },
        { file: "src/a.vue", line: 9, store: "cart", storeFile: "src/store.ts", reads: ["total", "items"], writes: [] },
      ],
    });
    assert.deepEqual([score.tp, score.fp, score.fn], [1, 1, 1]);
    assert.deepEqual(score.falsePositives, ["src/a.vue:9 -> src/store.ts cart reads [total] writes []"]);
    assert.deepEqual(score.falseNegatives, ["src/a.vue:9 -> src/store.ts cart reads [items,total] writes []"]);
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
      for (const page of labels.pages?.items ?? []) {
        assert.ok(page.file && page.fullPath.startsWith("/") && page.kind && page.component !== undefined, JSON.stringify(page));
      }
      for (const request of labels.requests?.items ?? []) {
        assert.ok(request.file && Number.isInteger(request.line) && /^[A-Z]+ \//.test(request.route) && request.routeFile, JSON.stringify(request));
      }
      for (const store of labels.stores?.items ?? []) {
        assert.ok(store.file && store.name && store.library && store.kind, JSON.stringify(store));
      }
      for (const use of labels.storeAccess?.items ?? []) {
        assert.ok(use.file && Number.isInteger(use.line) && use.store && use.storeFile && Array.isArray(use.reads) && Array.isArray(use.writes), JSON.stringify(use));
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
        ...(labels.pages?.items ?? []).map((page) => page.file),
        ...(labels.requests?.items ?? []).flatMap((request) => [request.file, request.routeFile]),
        ...(labels.stores?.items ?? []).map((store) => store.file),
        ...(labels.storeAccess?.items ?? []).flatMap((use) => [use.file, use.storeFile]),
      ]);
      for (const file of named) assert.ok(existsSync(path.join(projectPath, file)), `${file} is missing in ${labels.sample}`);
    });
  }
});

describe("accuracy comparator: scripts and infrastructure", () => {
  // `Makefile` declares the target `test` (line 3), which runs `scripts/t.sh`
  // (a script entrypoint) and the target `lint`; `package.json` has the npm
  // script `build`, which runs the make target; the workflow job runs it too.
  const graph: Graph = {
    nodes: [
      ...files("Makefile", "scripts/t.sh", "package.json", ".github/workflows/ci.yml", "docs/x.md"),
      node("e:make:test", "EntryPoint", { kind: "make", trigger: "test", line: 3 }),
      node("e:make:lint", "EntryPoint", { kind: "make", trigger: "lint", line: 6 }),
      node("e:script:t", "EntryPoint", { kind: "script", trigger: "scripts/t.sh", line: 1 }),
      node("e:npm:build", "EntryPoint", { kind: "npm-script", trigger: "build", line: 4 }),
      node("e:ci:job", "EntryPoint", { kind: "ci-job", trigger: "test", line: 8 }),
      node("e:go:main", "EntryPoint", { kind: "main", trigger: null, line: 1 }),
      node("env:A", "EnvVar", { name: "A" }),
      node("env:B", "EnvVar", { name: "B" }),
    ],
    relationships: [
      rel("file:Makefile", "DECLARES_ENTRYPOINT", "e:make:test"),
      rel("file:Makefile", "DECLARES_ENTRYPOINT", "e:make:lint"),
      rel("file:scripts/t.sh", "DECLARES_ENTRYPOINT", "e:script:t"),
      rel("file:package.json", "DECLARES_ENTRYPOINT", "e:npm:build"),
      rel("file:.github/workflows/ci.yml", "DECLARES_ENTRYPOINT", "e:ci:job"),
      rel("file:docs/x.md", "DECLARES_ENTRYPOINT", "e:go:main"),
      rel("e:make:test", "RUNS", "e:script:t"),
      rel("e:make:test", "RUNS", "e:make:lint"),
      rel("e:npm:build", "RUNS", "file:Makefile"),
      rel("e:ci:job", "RUNS", "e:make:test"),
      rel("e:ci:job", "RUNS", "e:make:test"),
      rel("repo", "DECLARES_ENV", "env:A", { file: "Makefile", line: 1 }),
      rel("repo", "DECLARES_ENV", "env:B", { file: "docs/x.md", line: 1 }),
    ],
  };

  it("scores entrypoints of the script kinds by file, kind, trigger and line ±1, in scope only", () => {
    const labels: NonNullable<Labels["scripts"]> = {
      scope: ["Makefile", "scripts/", "package.json", ".github/"],
      items: [
        { file: "Makefile", line: 4, kind: "make", trigger: "test" },
        { file: "Makefile", line: 6, kind: "make", trigger: "lint" },
        { file: "Makefile", line: 9, kind: "make", trigger: "missing" },
        { file: "scripts/t.sh", line: 1, kind: "script", trigger: "scripts/t.sh" },
        { file: "package.json", line: 4, kind: "npm-script", trigger: "build" },
      ],
    };
    const result = compareScripts(graph, labels);
    // `ci-job` is found and not labeled; the Go `main` is not a script kind.
    assert.deepEqual([result.tp, result.fp, result.fn], [4, 1, 1]);
    assert.deepEqual(result.falsePositives, [".github/workflows/ci.yml:8 ci-job test"]);
    assert.deepEqual(result.falseNegatives, ["Makefile:9 make missing"]);
  });

  it("scores what an entrypoint runs by target, counting a repeated link once", () => {
    const labels: NonNullable<Labels["runs"]> = {
      scope: ["Makefile", "package.json", ".github/"],
      items: [
        { file: "Makefile", kind: "make", trigger: "test", target: "scripts/t.sh" },
        { file: "Makefile", kind: "make", trigger: "test", target: "Makefile#lint" },
        { file: "package.json", kind: "npm-script", trigger: "build", target: "Makefile" },
        { file: ".github/workflows/ci.yml", kind: "ci-job", trigger: "test", target: "Makefile#test" },
        { file: ".github/workflows/ci.yml", kind: "ci-job", trigger: "test", target: "scripts/t.sh" },
      ],
    };
    const result = compareRuns(graph, labels);
    assert.deepEqual([result.tp, result.fp, result.fn], [4, 0, 1]);
    assert.deepEqual(result.falseNegatives, [".github/workflows/ci.yml ci-job test -> scripts/t.sh"]);
  });

  it("scores env declarations by file, line and name, in scope only", () => {
    const result = compareEnvDeclarations(graph, { scope: ["Makefile"], items: [{ file: "Makefile", line: 1, name: "A" }, { file: "Makefile", line: 2, name: "C" }] });
    assert.deepEqual([result.tp, result.fp, result.fn], [1, 0, 1]);
    assert.deepEqual(result.falseNegatives, ["Makefile:2 C"]);
  });
});

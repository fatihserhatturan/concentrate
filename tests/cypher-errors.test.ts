import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CypherError, type CypherErrorKind } from "../src/adapters/store/cypher/errors.js";
import { executeCypher } from "../src/adapters/store/cypher/executor.js";
import { MemoryGraph } from "../src/adapters/store/graph.js";

const graph = new MemoryGraph();
graph.addNode("File", "file:a.ts", { relativePath: "a.ts" });
graph.addNode("Function", "file:a.ts:function:run", { name: "run", isExported: true, line: 3 });
graph.addNode("Function", "file:a.ts:function:stop", { name: "stop", isExported: true, line: 9 });
graph.addRelationship("DEFINES_FUNCTION", "file:a.ts", "file:a.ts:function:run", {});
graph.addRelationship("DEFINES_FUNCTION", "file:a.ts", "file:a.ts:function:stop", {});

const run = (cypher: string, params: Record<string, unknown> = {}) => executeCypher(graph, cypher, params);

function assertError(cypher: string, kind: CypherErrorKind, message: RegExp, params: Record<string, unknown> = {}) {
  assert.throws(() => run(cypher, params), (error: unknown) => {
    assert.ok(error instanceof CypherError, `expected a CypherError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    assert.match(error.message, message);
    return true;
  });
}

describe("Cypher errors", () => {
  it("rejects names the schema does not have", () => {
    assertError("MATCH (x:Nope) RETURN x", "binder", /Binder exception: Table Nope does not exist/);
    assertError("MATCH (a:File)-[:NOPE]->(b) RETURN a", "binder", /Table NOPE does not exist/);
    assertError("MATCH (f:File) RETURN f.nope AS x", "binder", /Cannot find property nope for f/);
    assertError("MATCH (f:File) RETURN g AS x", "binder", /Variable g is not in scope/);
  });

  it("rejects what Kuzu rejects at bind time", () => {
    assertError("MATCH (f:File) WITH f ORDER BY f.relativePath RETURN f", "binder", /ORDER BY must be followed by SKIP or LIMIT/);
    assertError("MATCH (f:File) WITH f.relativePath RETURN 1 AS x", "binder", /must be aliased/);
    assertError("MATCH (f:File) RETURN f.relativePath AS a, f.path AS a", "binder", /same name a/);
    assertError("MATCH (fn:Function) RETURN fn.name + fn.line AS x", "binder", /Cannot add STRING and INT/);
    assertError("MATCH (fn:Function) RETURN nope(fn) AS x", "binder", /Function nope is not supported/);
  });

  it("rejects a missing parameter and an aggregate in WHERE", () => {
    assertError("MATCH (f:File) WHERE f.relativePath = $missing RETURN f", "binder", /Parameter \$missing is not provided/);
    assertError("MATCH (f:File) WHERE count(f) > 1 RETURN f", "binder", /not allowed in WHERE/);
    assertError("MATCH (f:File) RETURN count(collect(f)) AS n", "binder", /cannot be nested/);
  });

  it("names unsupported clauses", () => {
    assertError("CREATE (f:File {id: 'x'})", "unsupported", /Unsupported Cypher feature: CREATE .*read-only/);
    assertError("MATCH (f:File) DETACH DELETE f", "unsupported", /DETACH DELETE/);
    assertError("MATCH (f:File) SET f.language = 'x' RETURN f", "unsupported", /SET/);
    assertError("UNWIND [1] AS x RETURN x", "unsupported", /UNWIND/);
    assertError("MATCH (f:File) RETURN f UNION MATCH (f:File) RETURN f", "unsupported", /UNION/);
  });

  it("reports runtime errors", () => {
    assertError("RETURN 1 / 0 AS x", "runtime", /Divide by zero/);
    assertError("MATCH (f:File) RETURN f LIMIT $n", "runtime", /LIMIT expects a non-negative integer/, { n: -1 });
  });
});

describe("Cypher semantics outside the Kuzu corpus", () => {
  it("evaluates a bare boolean in CASE WHEN on every row (Kuzu 0.11 does not)", () => {
    assert.deepEqual(run("MATCH (fn:Function) RETURN fn.name AS name, CASE WHEN fn.isExported THEN 'public' ELSE 'private' END AS v ORDER BY name"), [
      { name: "run", v: "public" },
      { name: "stop", v: "public" },
    ]);
  });

  it("returns nodes and relationships with their schema properties", () => {
    const [row] = run("MATCH (f:File)-[r:DEFINES_FUNCTION]->(fn:Function {name: 'run'}) RETURN f, r");
    assert.deepEqual(row, {
      f: { _label: "File", id: "file:a.ts", path: null, relativePath: "a.ts", language: null, defaultExport: null, defaultExportFrom: null, sourceType: null, isTest: null, isFixture: null, isSupport: null, isGenerated: null, isDocs: null, dynamicRouteCalls: null, packageName: null, rustCrate: null, rustCrateName: null, rustModule: null },
      r: { _label: "DEFINES_FUNCTION", _src: "file:a.ts", _dst: "file:a.ts:function:run" },
    });
  });

  it("returns null for a property an unlabeled node's inferred tables lack, like Kuzu", () => {
    assert.deepEqual(run("MATCH (x)-[:DEFINES_FUNCTION]->(fn:Function {name: 'run'}) RETURN x.name AS name"), [{ name: null }]);
    assertError("MATCH (x:File) RETURN x.name AS name", "binder", /Cannot find property name for x/);
  });

  it("starts from an indexed equality and still applies the rest of WHERE", () => {
    assert.deepEqual(run("MATCH (fn:Function) WHERE fn.name = $name AND fn.line > 5 RETURN fn.name AS name", { name: "stop" }), [{ name: "stop" }]);
    assert.deepEqual(run("MATCH (fn:Function) WHERE fn.name = $name AND fn.line > 5 RETURN fn.name AS name", { name: "run" }), []);
  });
});

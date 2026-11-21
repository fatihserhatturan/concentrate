import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

// Phase 42 review fixes F2: config redaction, read detection, System shadowing, non-Java repos, test resources.
describe("Java config and env: review fixes", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });
  async function scan(files: Record<string, string>): Promise<Graph> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-config-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    return buildCodeGraph(dir, { continueOnError: false });
  }
  const value = (graph: Graph, name: string) => graph.nodes.find((node) => node.label === "ConfigValue" && node.properties.name === name)?.properties.value;
  const PLAIN = { "src/main/java/a/Plain.java": "package a;\npublic class Plain { }\n" };

  // "<function> -> <key>" of CONSUMES_CONFIG from functions.
  const consumed = (graph: Graph): string[] => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.relationships
      .filter((rel) => rel.type === "CONSUMES_CONFIG" && byId.get(rel.from)?.label === "Function")
      .map((rel) => `${String(byId.get(rel.from)!.properties.name)} -> ${String(byId.get(rel.to)!.properties.name)}`)
      .sort();
  };
  const envReads = (graph: Graph): string[] => {
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.relationships
      .filter((rel) => rel.type === "USES_ENV" && byId.get(rel.from)?.label === "Function")
      .map((rel) => `${String(byId.get(rel.from)!.properties.name)} ${String(byId.get(rel.to)!.properties.name)}`)
      .sort();
  };

  it("redacts by any segment of the key, a placeholder with a default, URL userinfo and password parameters; plain key stays", async () => {
    const graph = await scan({
      ...PLAIN,
      "src/main/resources/application.yml": [
        "app:", "  encryption-key: SUPERKEY", "  secret:", "    value: abc123", "  db-password: ${DB_PASSWORD:hunter2}", "  token: ${TOKEN}",
        "  clientSecret: s3", "  cache:", "    key-prefix: pre", "  url: https://u:pw@host/x", "  ref: https://u:${PW}@host/x",
        "  jdbc: jdbc:mysql://h/db?user=a&password=pw&x=1", "  key: plainkey", "",
      ].join("\n"),
    });
    assert.equal(value(graph, "app.encryption-key"), "<redacted>");
    assert.equal(value(graph, "app.secret.value"), "<redacted>");
    assert.equal(value(graph, "app.db-password"), "<redacted>");
    assert.equal(value(graph, "app.token"), "${TOKEN}");
    assert.equal(value(graph, "app.clientSecret"), "<redacted>");
    assert.equal(value(graph, "app.cache.key-prefix"), "pre");
    assert.equal(value(graph, "app.key"), "plainkey");
    assert.equal(value(graph, "app.url"), "https://u:<redacted>@host/x");
    assert.equal(value(graph, "app.ref"), "https://u:${PW}@host/x");
    assert.equal(value(graph, "app.jdbc"), "jdbc:mysql://h/db?user=a&password=<redacted>&x=1");
  });

  it("redacts the default of an @Value on a secret key", async () => {
    const graph = await scan({
      "src/main/java/a/S.java": "package a;\nimport org.springframework.beans.factory.annotation.Value;\npublic class S { String m(@Value(\"${secret.key:topsecret}\") String a, @Value(\"${cache.key:plain}\") String b) { return a; } }\n",
    });
    assert.equal(value(graph, "secret.key"), "<redacted>");
    assert.equal(value(graph, "cache.key"), "plain");
  });

  const field = (body: string) => ({
    "src/main/resources/application.properties": "x.y=1\n",
    "src/main/java/a/B.java": `package a;\nimport org.springframework.beans.factory.annotation.Value;\npublic class B {\n  @Value("\${x.y}") int xy;\n${body}\n}\n`,
  });

  it("counts `int z = xy;` as a read, and not an assignment target", async () => {
    const graph = await scan(field("  void one() { int z = xy; }\n  void set() { this.xy = 2; xy = 3; }\n  void plus() { xy += 1; }"));
    assert.deepEqual(consumed(graph), ["one -> x.y", "plus -> x.y"]);
  });

  it("lets a nested type that declares the same field hide it", async () => {
    const graph = await scan(field("  class Inner { int xy; int m() { return xy; } }\n  int outer() { return xy; }"));
    assert.deepEqual(consumed(graph), ["outer -> x.y"]);
  });

  it("takes System.getenv only for java.lang.System", async () => {
    const graph = await scan({
      "src/main/java/a/util/System.java": "package a.util;\npublic class System { public static String getenv(String s) { return s; } }\n",
      "src/main/java/a/util/Imp.java": "package a.util;\npublic class Imp { String samePkg() { return System.getenv(\"SAME_PKG\"); } }\n",
      "src/main/java/a/Imported.java": "package a;\nimport a.util.System;\npublic class Imported { String imported() { return System.getenv(\"IMPORTED\"); } }\n",
      "src/main/java/a/Ext.java": "package a;\nimport other.System;\npublic class Ext { String external() { return System.getenv(\"EXTERNAL\"); } }\n",
      "src/main/java/a/Own.java": "package a;\npublic class Own { static class System { static String getenv(String s) { return s; } } String own() { return System.getenv(\"NESTED\") + java.lang.System.getenv(\"REAL\"); } }\n",
      "src/main/java/a/Static.java": "package a;\nimport static a.util.System.getenv;\npublic class Static { String stat() { return getenv(\"STATIC_OTHER\"); } }\n",
      "src/main/java/a/Real.java": "package a;\npublic class Real { String real() { return System.getenv(\"REAL_ONE\"); } }\n",
    });
    assert.deepEqual(envReads(graph), ["own REAL", "real REAL_ONE"]);
  });

  it("makes nothing of a non-Java repo's resources/application.yml", async () => {
    const graph = await scan({
      "app/main.py": "import os\ndef f():\n    return os.environ['PORT']\n",
      "resources/application.yml": "db:\n  password: pw\nurl: ${PORT}\n",
    });
    assert.equal(graph.nodes.filter((node) => node.label === "ConfigValue").length, 0);
    assert.equal(graph.relationships.filter((rel) => rel.type === "DECLARES_CONFIG").length, 0);
    assert.deepEqual(graph.relationships.filter((rel) => rel.type === "USES_ENV" && rel.properties.access === "config placeholder"), []);
  });

  it("reads config/application.* at a root; test resources reach test readers only", async () => {
    const graph = await scan({
      "config/application.properties": "root.key=1\n",
      "src/test/resources/application.properties": "only.test=1\n",
      "src/main/java/a/M.java": "package a;\nimport org.springframework.beans.factory.annotation.Value;\npublic class M { void m(@Value(\"${only.test}\") String a, @Value(\"${root.key}\") String b) {} }\n",
      "src/test/java/a/T.java": "package a;\nimport org.springframework.beans.factory.annotation.Value;\npublic class T { void t(@Value(\"${only.test}\") String a) {} }\n",
    });
    assert.notEqual(value(graph, "root.key"), undefined);
    assert.deepEqual(consumed(graph), ["m -> root.key", "t -> only.test"]);
  });
});

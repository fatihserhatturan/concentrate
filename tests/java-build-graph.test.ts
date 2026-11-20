import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

type Scan = Awaited<ReturnType<typeof buildCodeGraph>>;

const scan = (directory: string): Promise<Scan> => buildCodeGraph(path.resolve(directory), { continueOnError: false });
const strip = (id: string) => id.replace(/^file:/u, "");

function packages(graph: Scan) {
  return graph.nodes.filter((node) => node.label === "Package" && (node.properties.manager === "maven" || node.properties.manager === "gradle"));
}

function pkg(graph: Scan, name: string) {
  const found = packages(graph).find((node) => node.properties.name === name);
  assert.ok(found, `package ${name} in ${packages(graph).map((node) => node.properties.name).join(", ")}`);
  return found;
}

function imports(graph: Scan): string[] {
  const names = new Map(graph.nodes.map((node) => [node.id, String(node.properties.name)]));
  return graph.relationships
    .filter((rel) => rel.type === "PACKAGE_IMPORTS_PACKAGE" && names.get(rel.from) !== undefined && packages(graph).some((node) => node.id === rel.from))
    .map((rel) => `${names.get(rel.from)} -> ${names.get(rel.to)} (${rel.properties.dependencyType})`)
    .sort();
}

function contained(graph: Scan, node: { id: string }): string[] {
  return graph.relationships.filter((rel) => rel.type === "PACKAGE_CONTAINS_FILE" && rel.from === node.id).map((rel) => strip(rel.to)).sort();
}

const roots = (node: { properties: Record<string, unknown> }, key: string) => JSON.parse(String(node.properties[key])) as string[];

describe("Java build graph: Maven (fixtures/java-maven)", () => {
  it("makes a Package per module with its manager, version and module dependencies", async () => {
    const graph = await scan("fixtures/java-maven");
    assert.deepEqual(packages(graph).map((node) => `${node.properties.relativePath} ${node.properties.name} ${node.properties.manager} ${node.properties.version}`).sort(), [
      ". com.acme.shop:shop-parent maven 1.2.0",
      "app com.acme.shop:shop-app maven 1.2.0",
      "core com.acme.shop:shop-core maven 1.2.0",
      "util com.acme.shop:shop-util maven 1.2.0",
    ]);
    const edges = imports(graph);
    assert.ok(edges.some((edge) => edge.startsWith("com.acme.shop:shop-app -> com.acme.shop:shop-core")), edges.join("\n"));
    assert.ok(edges.some((edge) => edge.startsWith("com.acme.shop:shop-core -> com.acme.shop:shop-util")), edges.join("\n"));
  });

  it("puts each file in its own module's package, not the aggregator's", async () => {
    const graph = await scan("fixtures/java-maven");
    assert.deepEqual(contained(graph, pkg(graph, "com.acme.shop:shop-app")), ["app/pom.xml", "app/src/main/java/com/acme/shop/app/ShopApp.java"]);
    const parent = contained(graph, pkg(graph, "com.acme.shop:shop-parent"));
    assert.ok(parent.includes("pom.xml"));
    assert.ok(!parent.some((file) => file.startsWith("app/")));
  });

  it("adds source roots, build system, aggregator and build file to the Package", async () => {
    const graph = await scan("fixtures/java-maven");
    const core = pkg(graph, "com.acme.shop:shop-core");
    assert.deepEqual(roots(core, "sourceRoots"), ["core/src/java"]);
    assert.equal(core.properties.buildSystem, "maven");
    assert.equal(core.properties.aggregator, false);
    assert.equal(core.properties.buildFile, "core/pom.xml");
    assert.equal(typeof core.properties.unresolved, "number");
    assert.equal(pkg(graph, "com.acme.shop:shop-parent").properties.aggregator, true);
    assert.deepEqual(roots(pkg(graph, "com.acme.shop:shop-util"), "testSourceRoots"), ["util/src/test/java"]);
  });

  it("links the pom's mainClass EntryPoint to the main method it names", async () => {
    const graph = await scan("fixtures/java-maven");
    const app = pkg(graph, "com.acme.shop:shop-app");
    assert.equal(app.properties.mainClass, "com.acme.shop.app.ShopApp");
    assert.equal(app.properties.mainClassSource, "spring-boot-maven-plugin");
    const entry = graph.nodes.find((node) => node.label === "EntryPoint" && node.properties.kind === "java-main-class");
    assert.ok(entry);
    assert.equal(entry.properties.library, "java");
    assert.equal(entry.properties.source, "spring-boot-maven-plugin");
    assert.equal(entry.properties.resolved, true);
    const declared = graph.relationships.find((rel) => rel.type === "DECLARES_ENTRYPOINT" && rel.to === entry.id);
    assert.equal(declared && strip(declared.from), "app/pom.xml");
    const runs = graph.relationships.filter((rel) => rel.type === "RUNS" && rel.from === entry.id);
    assert.equal(runs.length, 1);
    const main = graph.nodes.find((node) => node.id === runs[0]!.to)!;
    assert.equal(main.label, "EntryPoint");
    assert.equal(main.properties.kind, "main");
    const handler = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === main.id)!;
    assert.equal(graph.nodes.find((node) => node.id === handler.to)!.properties.qualifiedName, "com.acme.shop.app.ShopApp.main");
  });

  it("shows the root module's properties as repository config", async () => {
    const graph = await scan("fixtures/java-maven");
    const values = new Map(graph.nodes.filter((node) => node.label === "ConfigValue").map((node) => [String(node.properties.name), String(node.properties.value)]));
    assert.equal(values.get("pom.xml:maven.compiler.release"), "17");
    assert.ok(![...values.keys()].some((name) => name.startsWith("core/pom.xml")));
  });
});

describe("Java build graph: Gradle (fixtures/java-gradle)", () => {
  it("makes a Package per project and skips the intermediate :libs", async () => {
    const graph = await scan("fixtures/java-gradle");
    const names = packages(graph).map((node) => `${node.properties.relativePath} ${node.properties.name} ${node.properties.manager}`).sort();
    assert.ok(names.includes("app :app gradle"), names.join("\n"));
    assert.ok(names.includes("libs/core :libs:core gradle"), names.join("\n"));
    assert.ok(names.includes("libs/util :libs:util gradle"), names.join("\n"));
    assert.ok(!names.some((name) => name.endsWith(" :libs gradle")), names.join("\n"));
  });

  it("links the projects by their dependencies", async () => {
    const edges = imports(await scan("fixtures/java-gradle"));
    assert.ok(edges.some((edge) => edge.startsWith(":app -> :libs:core")), edges.join("\n"));
    assert.ok(edges.some((edge) => edge.startsWith(":libs:core -> :libs:util")), edges.join("\n"));
  });

  it("reads a custom srcDirs and contains the project's files", async () => {
    const graph = await scan("fixtures/java-gradle");
    const core = pkg(graph, ":libs:core");
    assert.deepEqual(roots(core, "sourceRoots"), ["libs/core/src"]);
    assert.equal(core.properties.buildFile, "libs/core/build.gradle");
    assert.ok(contained(graph, core).includes("libs/core/src/com/acme/shop/core/Order.java"));
  });

  it("links the application's mainClass EntryPoint to ShopApp's main", async () => {
    const graph = await scan("fixtures/java-gradle");
    const entry = graph.nodes.find((node) => node.label === "EntryPoint" && node.properties.kind === "java-main-class");
    assert.ok(entry);
    assert.equal(entry.properties.source, "application");
    const runs = graph.relationships.filter((rel) => rel.type === "RUNS" && rel.from === entry.id);
    assert.equal(runs.length, 1);
    assert.equal(graph.nodes.find((node) => node.id === runs[0]!.to)!.properties.kind, "main");
  });
});

describe("Java build graph: a mainClass the scan does not contain", () => {
  it("keeps the EntryPoint without RUNS and marks it unresolved", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "java-build-"));
    try {
      await mkdir(path.join(root, "src/main/java/com/acme"), { recursive: true });
      await writeFile(path.join(root, "src/main/java/com/acme/Other.java"), "package com.acme;\npublic class Other {}\n");
      await writeFile(path.join(root, "pom.xml"), `<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>com.acme</groupId>
  <artifactId>lonely</artifactId>
  <version>1</version>
  <build><plugins><plugin>
    <artifactId>spring-boot-maven-plugin</artifactId>
    <configuration><mainClass>com.acme.Missing</mainClass></configuration>
  </plugin></plugins></build>
</project>
`);
      const graph = await scan(root);
      const entry = graph.nodes.find((node) => node.label === "EntryPoint" && node.properties.kind === "java-main-class");
      assert.ok(entry);
      assert.equal(entry.properties.resolved, false);
      assert.equal(entry.properties.trigger, "com.acme.Missing");
      assert.equal(graph.relationships.some((rel) => rel.type === "RUNS" && rel.from === entry.id), false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("Java build graph: the same mainClass in two modules", () => {
  it("runs each module's own main", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "java-build-"));
    try {
      const write = async (file: string, text: string) => {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
      };
      await write("pom.xml", `<project><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging><modules><module>one</module><module>two</module></modules></project>\n`);
      for (const name of ["one", "two"]) {
        await write(`${name}/pom.xml`, `<project><modelVersion>4.0.0</modelVersion><groupId>com.acme</groupId><artifactId>${name}</artifactId><version>1</version>
  <build><plugins><plugin><artifactId>spring-boot-maven-plugin</artifactId><configuration><mainClass>com.acme.Application</mainClass></configuration></plugin></plugins></build></project>\n`);
        await write(`${name}/src/main/java/com/acme/Application.java`, "package com.acme;\npublic class Application { public static void main(String[] args) {} }\n");
      }
      const graph = await scan(root);
      const entries = graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.kind === "java-main-class");
      assert.equal(entries.length, 2);
      for (const entry of entries) {
        const module = entry.id.includes("one/pom.xml") ? "one" : "two";
        const runs = graph.relationships.filter((rel) => rel.type === "RUNS" && rel.from === entry.id);
        assert.equal(runs.length, 1, entry.id);
        assert.ok(runs[0]!.to.includes(`${module}/src/main/java/com/acme/Application.java`), `${module} -> ${runs[0]!.to}`);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

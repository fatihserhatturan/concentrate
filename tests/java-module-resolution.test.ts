import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { clearJavaBuildModelCache } from "../src/integrations/languages/java/build/index.js";
import { buildJavaPackageIndex } from "../src/integrations/languages/java/packages.js";

const scanRoot = async (root: string) => {
  clearJavaBuildModelCache();
  const result = await buildCodeGraph(root, { continueOnError: true, concurrency: 2 });
  const strip = (id: string) => id.replace(/^file:/u, "");
  const targets = (file: string, source: string): string[] => {
    const node = result.nodes.find((n) => n.label === "Import" && n.id.startsWith(`file:${file}:import:`) && n.properties.source === source);
    assert.ok(node, `import ${source} in ${file}`);
    return result.relationships.filter((r) => r.type === "RESOLVES_TO" && r.from === node.id).map((r) => strip(r.to)).sort();
  };
  // (importer basename, source, target basename) of every resolved import.
  const pairs = (): Set<string> => {
    const out = new Set<string>();
    for (const node of result.nodes) {
      if (node.label !== "Import" || !node.id.includes(".java:import:")) continue;
      const importer = path.posix.basename(node.id.slice("file:".length).split(":import:")[0]!);
      for (const r of result.relationships) {
        if (r.type === "RESOLVES_TO" && r.from === node.id) out.add(`${importer}|${String(node.properties.source)}|${path.posix.basename(strip(r.to))}`);
      }
    }
    return out;
  };
  return { result, targets, pairs };
};

const scan = (fixture: string) => scanRoot(path.resolve("fixtures", fixture));

describe("Java module-aware resolution", () => {
  it("resolves java-custom-root as java-packages and declares its root", async () => {
    const packages = await scan("java-packages");
    const custom = await scan("java-custom-root");
    const have = custom.pairs();
    const expected = packages.pairs();
    assert.ok(expected.size > 0);
    for (const pair of expected) assert.ok(have.has(pair), `lost ${pair}`);

    const index = buildJavaPackageIndex(
      {
        nodesWithLabel: (label) => custom.result.nodes.filter((n) => n.label === label),
        relationshipsOfType: (type) => custom.result.relationships.filter((r) => r.type === type),
      },
      { extraSourceRoots: ["code/main"] },
    );
    assert.ok(index.sourceRoots.all().includes("code/main"));
  });

  for (const [fixture, appRoot, coreRoot, utilRoot] of [
    ["java-maven", "app/src/main/java", "core/src/java", "util/src/main/java"],
    ["java-gradle", "app/src/main/java", "libs/core/src", "libs/util/src/main/java"],
  ] as const) {
    it(`resolves the cross-module imports of ${fixture}`, async () => {
      const { targets } = await scan(fixture);
      const app = `${appRoot}/com/acme/shop/app/ShopApp.java`;
      const service = `${coreRoot}/com/acme/shop/core/OrderService.java`;
      assert.deepEqual(targets(app, "com.acme.shop.core.OrderService"), [service]);
      assert.deepEqual(targets(app, "com.acme.shop.core.Order"), [`${coreRoot}/com/acme/shop/core/Order.java`]);
      assert.deepEqual(targets(service, "com.acme.shop.util.Money"), [`${utilRoot}/com/acme/shop/util/Money.java`]);
      assert.deepEqual(targets(service, "com.acme.shop.util.Slugs"), [`${utilRoot}/com/acme/shop/util/Slugs.java`]);
    });
  }

  it("keeps only the visible duplicate, and falls back when none is visible", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-modules-"));
    try {
      const pom = (artifact: string, dep?: string) =>
        `<project>\n  <modelVersion>4.0.0</modelVersion>\n  <groupId>com.x</groupId>\n  <artifactId>${artifact}</artifactId>\n  <version>1</version>\n` +
        (dep ? `  <dependencies><dependency><groupId>com.x</groupId><artifactId>${dep}</artifactId><version>1</version></dependency></dependencies>\n` : "") +
        "</project>\n";
      const write = async (file: string, text: string) => {
        await mkdir(path.dirname(path.join(root, file)), { recursive: true });
        await writeFile(path.join(root, file), text);
      };
      await write(
        "pom.xml",
        `<project><modelVersion>4.0.0</modelVersion><groupId>com.x</groupId><artifactId>parent</artifactId><version>1</version><packaging>pom</packaging><modules><module>a</module><module>b</module><module>c</module><module>app</module></modules></project>\n`,
      );
      await write("a/pom.xml", pom("a"));
      await write("b/pom.xml", pom("b"));
      await write("c/pom.xml", pom("c"));
      await write("app/pom.xml", pom("app", "a"));
      await write("a/src/main/java/com/x/Dup.java", "package com.x;\npublic class Dup {}\n");
      await write("b/src/main/java/com/x/Dup.java", "package com.x;\npublic class Dup {}\n");
      await write("app/src/main/java/com/app/Use.java", "package com.app;\nimport com.x.Dup;\nimport com.x.*;\npublic class Use { Dup d; }\n");
      await write("c/src/main/java/com/c/Use.java", "package com.c;\nimport com.x.Dup;\nimport com.x.*;\npublic class Use { Dup d; }\n");

      const { targets } = await scanRoot(root);
      const app = "app/src/main/java/com/app/Use.java";
      assert.deepEqual(targets(app, "com.x.Dup"), ["a/src/main/java/com/x/Dup.java"]);
      assert.deepEqual(targets(app, "com.x"), ["a/src/main/java/com/x/Dup.java"]);
      // No visible candidate: the package import keeps both files, the type import the first one.
      const c = "c/src/main/java/com/c/Use.java";
      assert.deepEqual(targets(c, "com.x"), ["a/src/main/java/com/x/Dup.java", "b/src/main/java/com/x/Dup.java"]);
      assert.equal(targets(c, "com.x.Dup").length, 1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, it } from "node:test";
import {
  clearJavaBuildModelCache,
  emptyJavaBuildModel,
  isGradleBuildFile,
  isJavaBuildFile,
  isMavenBuildFile,
  javaModuleKey,
  moduleOfFile,
  readJavaBuildModel,
  visibleModules,
  type JavaBuildModel,
  type JavaModule,
} from "../src/integrations/languages/java/build/index.js";

const FIXTURES = path.resolve(import.meta.dirname, "../fixtures");

function walk(root: string, dir = ""): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...walk(root, rel));
    else out.push(rel);
  }
  return out;
}

async function load(fixture: string): Promise<JavaBuildModel> {
  const root = path.join(FIXTURES, fixture);
  return readJavaBuildModel(root, walk(root));
}

function byName(model: JavaBuildModel, name: string): JavaModule {
  const found = model.modules.find((m) => m.name === name || m.name.endsWith(`:${name}`));
  assert.ok(found, `module ${name} in ${model.modules.map((m) => m.name).join(", ")}`);
  return found;
}

const fake = (partial: Partial<JavaModule> & { name: string; dir: string }): JavaModule => ({
  system: "maven",
  file: `${partial.dir}/pom.xml`,
  line: 1,
  version: null,
  aggregator: false,
  parent: null,
  sourceRoots: [],
  testSourceRoots: [],
  dependencies: [],
  mainClass: null,
  mainClassSource: null,
  config: [],
  unresolved: 0,
  ...partial,
});

beforeEach(() => clearJavaBuildModelCache());

describe("java build file predicates", () => {
  it("recognises build files by basename", () => {
    assert.ok(isMavenBuildFile("a/pom.xml"));
    assert.ok(!isMavenBuildFile("a/pom.xml.bak"));
    assert.ok(isGradleBuildFile("build.gradle.kts") && isGradleBuildFile("x/settings.gradle"));
    assert.ok(isJavaBuildFile("x/build.gradle") && !isJavaBuildFile("x/Main.java"));
  });
});

describe("readJavaBuildModel", () => {
  it("returns an empty model without build files", async () => {
    assert.deepEqual(await readJavaBuildModel(FIXTURES, ["a/Main.java"]), emptyJavaBuildModel());
  });

  it("reads the maven fixture", async () => {
    const model = await load("java-maven");
    const keys = model.modules.map(javaModuleKey);
    assert.equal(model.modules.length, 4);
    assert.equal(model.modules.find((m) => m.aggregator)?.name, "com.acme.shop:shop-parent");
    const util = byName(model, "shop-util");
    const core = byName(model, "shop-core");
    const app = byName(model, "shop-app");
    assert.deepEqual(core.dependencies.map((d) => d.module), [javaModuleKey(util)]);
    assert.deepEqual(app.dependencies.map((d) => d.module), [javaModuleKey(core)]);
    assert.deepEqual(core.sourceRoots, ["core/src/java"]);
    assert.equal(app.mainClass, "com.acme.shop.app.ShopApp");
    assert.equal(app.mainClassSource, "spring-boot-maven-plugin");
    assert.ok(keys.every((k) => k.startsWith("maven:")));
    assert.ok(model.files.includes("pom.xml"));
  });

  it("reads the gradle fixture", async () => {
    const model = await load("java-gradle");
    const names = model.modules.map((m) => m.name).sort();
    for (const n of [":", ":libs:util", ":libs:core", ":app"]) assert.ok(names.includes(n), `${n} in ${names}`);
    const core = byName(model, ":libs:core");
    const app = byName(model, ":app");
    assert.deepEqual(app.dependencies.map((d) => [d.module, d.scope]), [["gradle::libs:core", "implementation"]]);
    assert.deepEqual(core.dependencies.map((d) => [d.module, d.scope]), [["gradle::libs:util", "api"]]);
    assert.deepEqual(core.sourceRoots, ["libs/core/src"]);
    assert.ok(app.mainClass);
    assert.equal(app.mainClassSource, "application");
  });

  it("reads the custom root fixture", async () => {
    const model = await load("java-custom-root");
    assert.equal(model.modules.length, 1);
    assert.deepEqual(model.modules[0]!.sourceRoots, ["code/main"]);
  });

  it("memoizes the latest result", async () => {
    const root = path.join(FIXTURES, "java-maven");
    const files = walk(root);
    const first = await readJavaBuildModel(root, files);
    assert.equal(await readJavaBuildModel(root, files), first);
    clearJavaBuildModelCache();
    assert.notEqual(await readJavaBuildModel(root, files), first);
  });
});

describe("moduleOfFile / visibleModules", () => {
  const root = fake({ name: "root", dir: ".", aggregator: true });
  const core = fake({ name: "core", dir: "core", sourceRoots: ["core/src/java"], testSourceRoots: ["core/test"] });
  const app = fake({ name: "app", dir: "core/app", sourceRoots: ["core/app/src"], dependencies: [{ module: "maven:core", scope: "compile" }] });
  const model: JavaBuildModel = { modules: [root, core, app], files: [], unresolved: 0 };

  it("prefers the longest containing source root", () => {
    assert.equal(moduleOfFile(model, "core/src/java/a/B.java"), core);
    assert.equal(moduleOfFile(model, "core/test/T.java"), core);
    assert.equal(moduleOfFile(model, "core/app/src/X.java"), app);
  });

  it("falls back to the longest directory, aggregators last", () => {
    assert.equal(moduleOfFile(model, "core/other/X.java"), core);
    assert.equal(moduleOfFile(model, "docs/X.java"), root);
    const tie = fake({ name: "same", dir: "." });
    assert.equal(moduleOfFile({ ...model, modules: [root, tie] }, "x/Y.java"), tie);
    assert.equal(moduleOfFile({ modules: [], files: [], unresolved: 0 }, "x"), undefined);
  });

  it("closes dependencies transitively and survives cycles", () => {
    const a = fake({ name: "a", dir: "a", dependencies: [{ module: "maven:b", scope: "compile" }] });
    const b = fake({ name: "b", dir: "b", dependencies: [{ module: "maven:c", scope: "compile" }] });
    const c = fake({ name: "c", dir: "c", dependencies: [{ module: "maven:a", scope: "compile" }] });
    const m: JavaBuildModel = { modules: [a, b, c], files: [], unresolved: 0 };
    assert.deepEqual([...visibleModules(m, "maven:a")].sort(), ["maven:a", "maven:b", "maven:c"]);
    assert.deepEqual([...visibleModules(m, "maven:zzz")], ["maven:zzz"]);
  });
});

describe("readJavaBuildModel cache key", () => {
  it("follows the content of a build file even when its size and mtime are unchanged", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "java-cache-"));
    try {
      const file = path.join(root, "pom.xml");
      const pom = (artifact: string) => `<project><groupId>g</groupId><artifactId>${artifact}</artifactId><version>1</version></project>`;
      writeFileSync(file, pom("aaa"));
      const when = new Date("2020-01-01T00:00:00Z");
      utimesSync(file, when, when);
      const first = await readJavaBuildModel(root, ["pom.xml"]);
      assert.equal(first.modules[0]!.name, "g:aaa");
      writeFileSync(file, pom("bbb"));
      utimesSync(file, when, when);
      const second = await readJavaBuildModel(root, ["pom.xml"]);
      assert.equal(second.modules[0]!.name, "g:bbb");
      assert.equal(await readJavaBuildModel(root, ["pom.xml"]), second);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

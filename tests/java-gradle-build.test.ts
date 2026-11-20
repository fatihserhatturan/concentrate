import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { interpretGradle } from "../src/integrations/languages/java/build/gradle.js";

function run(texts: Record<string, string>, extraFiles: string[] = []) {
  const files = new Set([...Object.keys(texts), ...extraFiles]);
  return interpretGradle({ files, texts: new Map(Object.entries(texts)) });
}

const mod = (model: ReturnType<typeof run>, name: string) => {
  const m = model.modules.find((x) => x.name === name);
  assert.ok(m, `module ${name} in ${model.modules.map((x) => x.name).join(",")}`);
  return m;
};

describe("gradle build reader", () => {
  it("reads Groovy includes, nested paths and projects without build files", () => {
    const model = run(
      {
        "settings.gradle": "rootProject.name = 'demo'\ninclude 'app', ':lib:core'\ninclude 'util'\n",
        "build.gradle": "plugins { id 'java' }\nversion = '1.0'\ngroup = 'org.demo'\n",
        "app/build.gradle": "apply plugin: 'java'\n",
      },
      ["app/src/main/java/A.java", "lib/core/src/main/java/B.java", "util/X.java"],
    );
    assert.deepEqual(model.modules.map((m) => m.name), [":", ":app", ":lib", ":lib:core", ":util"]);
    const root = mod(model, ":");
    assert.equal(root.version, "1.0");
    assert.equal(root.aggregator, false);
    assert.deepEqual(root.config, [{ key: "rootProject.name", value: "demo" }, { key: "group", value: "org.demo" }]);
    assert.deepEqual(mod(model, ":lib:core").sourceRoots, ["lib/core/src/main/java"]);
    const util = mod(model, ":util");
    assert.equal(util.file, "settings.gradle");
    assert.equal(util.line, 3);
    assert.equal(mod(model, ":app").file, "app/build.gradle");
    assert.deepEqual(model.files, ["app/build.gradle", "build.gradle", "settings.gradle"]);
  });

  it("reads the Kotlin DSL and marks a bare root as aggregator", () => {
    const model = run(
      {
        "settings.gradle.kts": 'rootProject.name = "k"\ninclude(":a", ":b:c")\n',
        "build.gradle.kts": "// nothing\n",
        "a/build.gradle.kts": 'plugins { `java-library` }\n',
      },
      ["b/c/x.txt"],
    );
    assert.equal(mod(model, ":").aggregator, true);
    assert.equal(mod(model, ":b:c").dir, "b/c");
    assert.equal(mod(model, ":a").aggregator, false);
  });

  it("applies projectDir overrides and counts missing directories", () => {
    const model = run(
      {
        "settings.gradle": "include 'a', 'b', 'gone'\nproject(':a').projectDir = new File(settingsDir, 'modules/alpha')\nproject(':b').projectDir = file(\"$rootDir/beta\")\n",
      },
      ["modules/alpha/build.gradle", "beta/x.txt", "b/x.txt"],
    );
    assert.equal(mod(model, ":a").dir, "modules/alpha");
    assert.equal(mod(model, ":b").dir, "beta");
    assert.equal(mod(model, ":gone").unresolved, 1);
    assert.equal(model.unresolved, 1);
  });

  it("reads dependencies in every form", () => {
    const model = run(
      {
        "settings.gradle.kts": 'include("app", "core-api", "core:impl")\n',
        "app/build.gradle.kts": [
          "dependencies {",
          '  implementation(project(":core-api"))',
          '  testImplementation(project(path = ":core:impl"))',
          "  api(projects.coreApi)",
          "  runtimeOnly(projects.core.impl)",
          '  implementation("org.x:y:1")',
          '  implementation(project(":nope"))',
          "}",
        ].join("\n"),
        "core-api/build.gradle": "dependencies { compileOnly project(':app') }\n",
      },
      ["core/impl/x", "app/x", "core-api/x"],
    );
    const app = mod(model, ":app");
    assert.deepEqual(app.dependencies, [
      { module: "gradle::core-api", scope: "implementation" },
      { module: "gradle::core:impl", scope: "testImplementation" },
      { module: "gradle::core-api", scope: "api" },
      { module: "gradle::core:impl", scope: "runtimeOnly" },
    ]);
    assert.equal(app.unresolved, 1);
    assert.deepEqual(mod(model, ":core-api").dependencies, [{ module: "gradle::app", scope: "compileOnly" }]);
  });

  it("reads Groovy dependency forms", () => {
    const model = run(
      {
        "settings.gradle": "include 'a', 'b'\n",
        "a/build.gradle": "dependencies {\n  api project(':b')\n  annotationProcessor project(path: ':b', configuration: 'x')\n  implementation project(':b') { transitive = false }\n}\n",
      },
      ["a/x", "b/x"],
    );
    assert.deepEqual(mod(model, ":a").dependencies, [
      { module: "gradle::b", scope: "api" },
      { module: "gradle::b", scope: "annotationProcessor" },
      { module: "gradle::b", scope: "implementation" },
    ]);
  });

  it("source sets: replace versus add, Groovy and Kotlin forms", () => {
    const model = run(
      {
        "settings.gradle": "include 'a', 'b', 'c', 'd', 'e'\n",
        "a/build.gradle": "sourceSets {\n  main { java { srcDirs = ['src', 'gen'] } }\n  test { java.srcDir 'tests' }\n}\n",
        "b/build.gradle": "sourceSets.main.java.srcDirs += 'extra'\nsourceSets { main { java { srcDir 'more' } } }\n",
        "c/build.gradle.kts": 'sourceSets {\n  main { java.srcDir("k1") }\n  test { java.setSrcDirs(listOf("kt")) }\n}\nsourceSets["main"].java.srcDirs("k2")\n',
        "d/build.gradle.kts": 'sourceSets.main { java.srcDirs("$projectDir/x", "${rootDir}/shared") }\n',
        "e/build.gradle": "sourceSets { main { java { srcDirs = [\"$buildDir/gen\", \"$foo/bar\"] } } }\n",
      },
      ["a/x", "b/x", "c/x", "d/x", "e/x"],
    );
    assert.deepEqual(mod(model, ":a").sourceRoots, ["a/src", "a/gen"]);
    assert.deepEqual(mod(model, ":a").testSourceRoots, ["a/src/test/java", "a/tests"]);
    assert.deepEqual(mod(model, ":b").sourceRoots, ["b/src/main/java", "b/extra", "b/more"]);
    assert.deepEqual(mod(model, ":c").sourceRoots, ["c/src/main/java", "c/k1", "c/k2"]);
    assert.deepEqual(mod(model, ":c").testSourceRoots, ["c/kt"]);
    assert.deepEqual(mod(model, ":d").sourceRoots, ["d/src/main/java", "d/x", "shared"]);
    const e = mod(model, ":e");
    assert.deepEqual(e.sourceRoots, ["e/src/main/java"]);
    assert.equal(e.unresolved, 2);
  });

  it("applies subprojects sourceSets only", () => {
    const model = run(
      {
        "settings.gradle": "include 'a', 'b'\n",
        "build.gradle": "subprojects {\n  sourceSets { main { java { srcDirs = ['java'] } } }\n  dependencies { implementation project(':a') }\n}\n",
      },
      ["a/x", "b/x"],
    );
    assert.deepEqual(mod(model, ":a").sourceRoots, ["a/java"]);
    assert.deepEqual(mod(model, ":b").sourceRoots, ["b/java"]);
    assert.deepEqual(mod(model, ":").sourceRoots, ["src/main/java"]);
    assert.deepEqual(mod(model, ":b").dependencies, []);
    assert.equal(mod(model, ":").aggregator, true);
  });

  it("allprojects reaches the root and own settings win", () => {
    const model = run(
      {
        "settings.gradle": "include 'a'\n",
        "build.gradle": "allprojects { sourceSets.main.java.srcDirs = ['s'] }\n",
        "a/build.gradle": "sourceSets.main.java.srcDirs = ['own']\n",
      },
      ["a/x"],
    );
    assert.deepEqual(mod(model, ":").sourceRoots, ["s"]);
    assert.deepEqual(mod(model, ":").aggregator, false);
    assert.deepEqual(mod(model, ":a").sourceRoots, ["a/own"]);
  });

  it("reads main class variants", () => {
    const model = run(
      {
        "settings.gradle": "include 'a', 'b', 'c', 'd', 'e'\n",
        "a/build.gradle": "application { mainClass = 'com.A' }\n",
        "b/build.gradle.kts": 'application { mainClass.set("com.B") }\n',
        "c/build.gradle": "mainClassName = 'com.C'\n",
        "d/build.gradle.kts": 'springBoot { mainClass.set("com.D") }\n',
        "e/build.gradle": "application { mainClass = \"$pkg.E\" }\n",
      },
      ["a/x", "b/x", "c/x", "d/x", "e/x"],
    );
    assert.deepEqual([mod(model, ":a").mainClass, mod(model, ":a").mainClassSource], ["com.A", "application"]);
    assert.equal(mod(model, ":b").mainClass, "com.B");
    assert.equal(mod(model, ":c").mainClass, "com.C");
    assert.deepEqual([mod(model, ":d").mainClass, mod(model, ":d").mainClassSource], ["com.D", "spring-boot"]);
    assert.equal(mod(model, ":e").mainClass, null);
    assert.equal(mod(model, ":e").unresolved, 1);
  });

  it("reads Java config entries", () => {
    const model = run({
      "build.gradle.kts": 'plugins { java }\nversion = "2.1"\njava {\n  sourceCompatibility = JavaVersion.VERSION_17\n  toolchain { languageVersion.set(JavaLanguageVersion.of(21)) }\n}\n',
    });
    const root = mod(model, ":");
    assert.equal(root.version, "2.1");
    assert.deepEqual(root.config, [
      { key: "sourceCompatibility", value: "17" },
      { key: "java.toolchain.languageVersion", value: "21" },
    ]);
  });

  it("a build file without settings is one root module", () => {
    const model = run({ "build.gradle": "version = \"$v\"\n" });
    assert.equal(model.modules.length, 1);
    const root = model.modules[0]!;
    assert.equal(root.name, ":");
    assert.equal(root.dir, ".");
    assert.equal(root.version, null);
    assert.equal(root.unresolved, 1);
    assert.equal(model.unresolved, 1);
  });

  it("ignores include in comments and strings", () => {
    const model = run({
      "settings.gradle": "// include 'fake1'\n/* include 'fake2'\ninclude 'fake3' */\nrootProject.name = \"include 'fake4'\"\ndef s = \"include('fake5')\"\ninclude 'real'\n",
    }, ["real/x"]);
    assert.deepEqual(model.modules.map((m) => m.name), [":", ":real"]);
    assert.equal(model.modules[1]!.line, 6);
  });

  it("counts an interpolated or dynamic include as unresolved on the root", () => {
    const model = run({ "settings.gradle": "include \"$x\"\nfor (n in ['a']) { include n }\n" });
    assert.equal(mod(model, ":").unresolved, 2);
  });

  it("prefixes secondary builds and never throws on odd input", () => {
    const model = run({
      "settings.gradle": "include 'a'\n",
      "build-logic/settings.gradle": "include 'conv'\n",
      "tool/build.gradle": "sourceSets {{{ ((( ",
    }, ["a/x", "build-logic/conv/x"]);
    assert.deepEqual(model.modules.map((m) => m.name), [":", ":a", "build-logic", "build-logic:conv", "tool"]);
    for (const text of ["", "}}}", "include(", "'unterminated", "\"\"\"x", "/* x", "a.b.c.d = ", "include ':a' project(':a').projectDir =", "${", "`"]) {
      assert.doesNotThrow(() => run({ "settings.gradle": text, "build.gradle": text }));
    }
  });
});

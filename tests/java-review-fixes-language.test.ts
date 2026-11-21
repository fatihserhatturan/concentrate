import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { defaultLanguageTable } from "../src/composition/default-registry.js";
import { classifyFile } from "../src/core/scan/file-classification.js";
import { createJavaParser } from "../src/integrations/languages/java/parser.js";

async function project(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "java-review-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text);
  }
  return directory;
}

async function targets(files: Record<string, string>, file: string, line: number): Promise<string[]> {
  const graph = await buildCodeGraph(await project(files), { continueOnError: false });
  const calls = new Set(graph.nodes.filter((node) => node.label === "Call" && node.id.includes(`file:${file}`) && node.properties.line === line).map((node) => node.id));
  const names = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "CALL_RESOLVES_TO" && calls.has(rel.from))
    .map((rel) => `${String(names.get(rel.to)?.properties.qualifiedName ?? names.get(rel.to)?.properties.name)}@${String(names.get(rel.to)?.properties.line)}`)
    .sort();
}

describe("Java language review fixes (Phase 43 review #1)", () => {
  const svc = `package p;
public class Svc {
  void take(Dog d) {}
  void take(Cat c) {}
  void take(String s) {}
}
`;
  const model = {
    "src/main/java/p/Dog.java": "package p;\npublic class Dog {}\n",
    "src/main/java/p/Cat.java": "package p;\npublic class Cat {}\n",
    "src/main/java/p/Box.java": "package p;\npublic record Box(Dog pet) {}\n",
    "src/main/java/p/Svc.java": svc,
  };

  it("types switch-pattern bindings, never as a same-named field of another type", async () => {
    const files = {
      ...model,
      "src/main/java/p/A.java": `package p;
public class A {
  Cat pet;
  Svc svc;
  void sw(Object o) {
    switch (o) {
      case Dog pet -> svc.take(pet);
      default -> {}
    }
  }
}
`,
    };
    assert.deepEqual(await targets(files, "src/main/java/p/A.java", 7), ["p.Svc.take@3"]);
  });

  it("types record-pattern component bindings", async () => {
    const files = {
      ...model,
      "src/main/java/p/A.java": `package p;
public class A {
  Cat pet;
  Svc svc;
  void rec(Object o) {
    if (o instanceof Box(Dog pet)) svc.take(pet);
  }
}
`,
    };
    assert.deepEqual(await targets(files, "src/main/java/p/A.java", 6), ["p.Svc.take@3"]);
  });

  it("does not turn an untyped bound name into a field lookup", async () => {
    const files = {
      ...model,
      "src/main/java/p/A.java": `package p;
public class A {
  Cat pet;
  Svc svc;
  void rec(Object o) {
    if (o instanceof Box(var pet)) svc.take(pet);
  }
}
`,
    };
    assert.ok(!(await targets(files, "src/main/java/p/A.java", 6)).every((target) => target === "p.Svc.take@4"));
  });

  it("treats directories below a JVM source root as package names for isTest", () => {
    const conventions = defaultLanguageTable.conventions;
    assert.equal(classifyFile("src/main/java/org/acme/test/Helper.java", conventions).isTest, false);
    assert.equal(classifyFile("src/main/java/org/acme/test/Helper.java", conventions).sourceType, "production");
    assert.equal(classifyFile("src/test/java/org/acme/Helper.java", conventions).isTest, true);
    assert.equal(classifyFile("src/main/java/org/acme/FooTest.java", conventions).isTest, true);
    assert.equal(classifyFile("src/main/java/org/acme/FooTests.java", conventions).isTest, true);
    assert.equal(classifyFile("src/main/java/org/acme/FooIT.java", conventions).isTest, true);
    assert.equal(classifyFile("tests/Foo.java", conventions).isTest, true);
  });

  it("a method type variable shadows a class type variable of the same name", async () => {
    const files = {
      "src/main/java/p/Dog.java": "package p;\npublic class Dog { void speak() {} }\n",
      "src/main/java/p/Cat.java": "package p;\npublic class Cat { void speak() {} }\n",
      "src/main/java/p/Base.java": "package p;\npublic class Base<T> {\n  <T> T pick(T a) { return a; }\n}\n",
      "src/main/java/p/Sub.java": "package p;\npublic class Sub extends Base<Dog> {}\n",
      "src/main/java/p/Use.java": "package p;\npublic class Use {\n  void a(Sub s, Cat c) {\n    s.pick(c).speak();\n  }\n}\n",
    };
    const resolved = await targets(files, "src/main/java/p/Use.java", 4);
    assert.ok(!resolved.some((target) => target.startsWith("Dog.speak")), resolved.join(","));
  });

  it("an explicit non-JDK import of a JDK simple name wins over a JDK wildcard", async () => {
    const files = {
      "src/main/java/p/Listener.java": "package p;\npublic interface Listener { void done(); }\n",
      "src/main/java/p/Use.java": `package p;
import com.google.common.base.Optional;
import java.util.*;
public class Use {
  void a(Optional<Listener> listener) {
    listener.get().done();
  }
}
`,
    };
    assert.deepEqual(await targets(files, "src/main/java/p/Use.java", 6), []);
  });

  it("the base Java parser cache version is bumped", () => {
    assert.equal(createJavaParser().version, "2");
    assert.equal(createJavaParser([{ version: "x" } as never]).version, "2+x");
  });
});

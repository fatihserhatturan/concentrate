import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

async function project(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "java-resolver-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text);
  }
  return directory;
}

// "file:line" of the function each call on `line` of `file` resolves to.
async function targets(files: Record<string, string>, file: string, line: number): Promise<string[]> {
  const graph = await buildCodeGraph(await project(files), { continueOnError: false });
  const calls = new Set(graph.nodes.filter((node) => node.label === "Call" && node.id.includes(`file:${file}`) && node.properties.line === line).map((node) => node.id));
  const names = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "CALL_RESOLVES_TO" && calls.has(rel.from))
    .map((rel) => `${String(names.get(rel.to)?.properties.qualifiedName ?? names.get(rel.to)?.properties.name)}`)
    .sort();
}

describe("Java resolver precision (Phase 43)", () => {
  it("does not resolve a wildcard import to a single file", async () => {
    const graph = await buildCodeGraph(await project({
      "src/main/java/a/One.java": "package a;\npublic class One {}\n",
      "src/main/java/a/Two.java": "package a;\npublic class Two {}\n",
      "src/main/java/b/Use.java": "package b;\nimport a.*;\npublic class Use { One one; }\n",
    }), { continueOnError: false });
    assert.equal(graph.relationships.filter((rel) => rel.type === "RESOLVES_TO" && rel.from.includes(":import:")).length, 0);
  });

  it("picks the constructor whose parameter types fit", async () => {
    const found = await targets({
      "src/main/java/p/Other.java": "package p;\npublic class Other {}\n",
      "src/main/java/p/Box.java": `package p;
public class Box {
  public Box(Other other) {}
  private Box(Builder builder) {}
  public static class Builder {
    public Box build() {
      return new Box(this);
    }
  }
}
`,
    }, "src/main/java/p/Box.java", 7);
    assert.equal(found.length, 1);
  });

  it("types Optional.get() and lambda parameters of Optional.map", async () => {
    const files = {
      "src/main/java/p/Listener.java": "package p;\npublic interface Listener { void done(); }\n",
      "src/main/java/p/Impl.java": "package p;\npublic class Impl implements Listener { public void done() {} }\n",
      "src/main/java/p/Use.java": `package p;
import java.util.Optional;
public class Use {
  void a(Optional<Listener> listener) {
    listener.get().done();
  }
  void b(Optional<Listener> listener) {
    listener.map(l -> { l.done(); return 1; });
  }
}
`,
    };
    assert.equal((await targets(files, "src/main/java/p/Use.java", 5)).length, 2);
    assert.equal((await targets(files, "src/main/java/p/Use.java", 8)).length, 2);
  });

  it("binds a lambda parameter typed by a superclass type argument", async () => {
    const found = await targets({
      "src/main/java/p/Ctx.java": "package p;\npublic class Ctx { public String name() { return \"\"; } }\n",
      "src/main/java/p/Base.java": "package p;\nimport java.util.function.Function;\npublic abstract class Base<C> { protected void resolver(Function<C, String> f) {} }\n",
      "src/main/java/p/Sub.java": "package p;\npublic class Sub extends Base<Ctx> { void m() { resolver(c -> c.name()); } }\n",
    }, "src/main/java/p/Sub.java", 2);
    assert.ok(found.includes("p.Ctx.name"), found.join(","));
  });

  it("persists only certain argument types of a call, never expression text", async () => {
    const graph = await buildCodeGraph(await project({
      "src/main/java/p/Box.java": `package p;
public class Box {
  private final Other held = null;
  public Box(Other other, String name) {}
  public Box(String name, int count) {}
  void make(Other typed, Object unknown) {
    new Box(typed, "x");
    new Box(compute(unknown), compute(typed));
    new Box("y", 3);
    make(this.held, new Other());
  }
  Other compute(Object o) { return null; }
}
class Other {}
`,
    }), { continueOnError: false });
    const calls = graph.nodes.filter((node) => node.label === "Call" && node.id.includes("file:src/main/java/p/Box.java"));
    const types = (line: number, callee: string) => calls.find((node) => node.properties.line === line && node.properties.callee === callee)?.properties.argumentTypes;
    assert.equal(types(7, "Box"), JSON.stringify(["Other", "String"]));
    assert.equal(types(8, "Box"), undefined);
    assert.equal(types(9, "Box"), JSON.stringify(["String", "int"]));
    assert.equal(types(10, "make"), JSON.stringify(["@held", "Other"]));
    for (const node of calls) assert.ok(!String(node.properties.argumentTypes ?? "").includes("("));
    assert.equal(graph.nodes.filter((node) => node.label === "Function").some((node) => String(node.properties.javaLocals).includes("#")), false);
  });
});

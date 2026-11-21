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
});

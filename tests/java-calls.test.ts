import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { BuildCodeGraphResult } from "../src/core/scan/result.js";
import type { GraphStore } from "../src/adapters/store/store.js";
import { openTestStore } from "./helpers/store.js";

const scan = (directory: string) => buildCodeGraph(path.resolve(directory), { continueOnError: true, concurrency: 2, keepCallSites: true });

// `Main.java::com.acme.Main.run` style labels for function ids (the line is dropped).
const functionLabel = (id: string) => id.replace(/^file:/u, "").replace(/:function:\d+:/u, "::");
const shorten = (label: string) => label.replace(/^.*\/(?=[^/]+\.java::)/u, "");

// `Main.java::com.acme.Main.run service.handle` -> the functions it resolves to ("(override)", "(overload)" via marks).
function callTargets(result: BuildCodeGraphResult): Map<string, string[][]> {
  const byCall = new Map<string, string[]>();
  for (const rel of result.relationships) {
    if (rel.type !== "CALL_RESOLVES_TO") continue;
    byCall.set(rel.from, [...byCall.get(rel.from) ?? [], shorten(functionLabel(rel.to)) + (rel.properties.via ? ` (${String(rel.properties.via)})` : "")]);
  }
  const resolved = new Map<string, string[][]>();
  for (const node of result.nodes) {
    if (node.label !== "Call") continue;
    const key = shorten(functionLabel(node.id).replace(/:call:\d+:\d+:/u, " "));
    resolved.set(key, [...resolved.get(key) ?? [], (byCall.get(node.id) ?? []).sort()]);
  }
  return resolved;
}

const one = (calls: Map<string, string[][]>, key: string): string[] => {
  const found = calls.get(key);
  assert.ok(found && found.length >= 1, `call ${key}`);
  return found[0]!;
};

const edges = (result: BuildCodeGraphResult, type: string): string[] =>
  result.relationships
    .filter((rel) => rel.type === type)
    .map((rel) => `${rel.from.replace(/^.*:(?:class|interface):\d+:/u, "")} -> ${rel.to.replace(/^.*:(?:class|interface):\d+:/u, "")}`)
    .sort();

describe("Java calls: java-calls fixture", () => {
  let result: BuildCodeGraphResult;
  let calls: Map<string, string[][]>;
  before(async () => {
    result = await scan("fixtures/java-calls");
    calls = callTargets(result);
  });

  const main = (expression: string) => `Main.java::com.acme.Main.${expression}`;

  it("resolves a field receiver, locals, parameters, var inference and this", () => {
    assert.deepEqual(one(calls, main("run service.handle")), ["Service.java::com.acme.Service.handle"]);
    for (const expression of ["local.handle", "param.handle", "inferred.handle"]) {
      assert.deepEqual(one(calls, main(`locals ${expression}`)), ["Service.java::com.acme.Service.handle"], expression);
    }
    assert.deepEqual(one(calls, main("locals this.run")), ["Main.java::com.acme.Main.run"]);
  });

  it("resolves static calls, static imports and chained calls through return types", () => {
    assert.deepEqual(one(calls, main("statics MathUtil.twice")), ["MathUtil.java::com.acme.util.MathUtil.twice"]);
    assert.deepEqual(one(calls, main("statics thrice")), ["MathUtil.java::com.acme.util.MathUtil.thrice"]);
    assert.deepEqual(one(calls, main("chained service.chain")), ["Service.java::com.acme.Service.chain"]);
    assert.deepEqual(one(calls, main("chained service.chain().step")), ["Service.java::com.acme.Service.step"]);
    assert.deepEqual(one(calls, main("chained service.chain().step().handle")), ["Service.java::com.acme.Service.handle"]);
  });

  it("picks overloads by argument count and marks same-arity overloads as ambiguous", () => {
    const targetIds = (expression: string) =>
      result.nodes
        .filter((node) => node.label === "Call" && node.properties.expression === expression)
        .map((node) => result.relationships.filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.from === node.id).map((rel) => rel.to));
    const adds = targetIds("calc.add");
    assert.deepEqual(adds.map((found) => found.length), [1, 1]);
    // add(int,int) for two arguments, add(int,int,int) for three.
    assert.match(adds[0]![0]!, /Calc\.add$/u);
    assert.notEqual(adds[0]![0], adds[1]![0]);
    // print(String) and print(Object): both candidates, each marked as an overload, none guessed.
    const printed = one(calls, main("overloads printer.print"));
    assert.equal(printed.length, 2);
    assert.ok(printed.every((target) => target.startsWith("Printer.java::com.acme.Printer.print") && target.endsWith("(overload)")), printed.join());
  });

  it("marks interface, abstract and override dispatch as override", () => {
    assert.deepEqual(one(calls, main("dispatch animal.speak")), ["Animal.java::com.acme.shapes.Animal.speak"]);
    assert.deepEqual(one(calls, main("dispatch animal.sound")), ["Animal.java::com.acme.shapes.Animal.sound", "Dog.java::com.acme.shapes.Dog.sound (override)"]);
    const area = ["Circle.java::com.acme.shapes.Circle.area (override)", "Shape.java::com.acme.shapes.Shape.area", "Square.java::com.acme.shapes.Square.area (override)"];
    assert.deepEqual(one(calls, main("dispatch shape.area")), area);
    const instances = calls.get(main("instances c.area"))!.concat(calls.get(main("instances s.area"))!);
    for (const targets of instances) assert.deepEqual(targets, area);
    // A construction names the exact class: no dispatch.
    assert.deepEqual(one(calls, main("instances new Dog().loud")), ["Dog.java::com.acme.shapes.Dog.loud"]);
  });

  it("resolves this, super and bare calls inside the hierarchy", () => {
    assert.deepEqual(one(calls, "Dog.java::com.acme.shapes.Dog.name super.name"), ["Animal.java::com.acme.shapes.Animal.name"]);
    assert.deepEqual(one(calls, "Dog.java::com.acme.shapes.Dog.loud this.sound"), ["Dog.java::com.acme.shapes.Dog.sound"]);
    assert.deepEqual(one(calls, "Dog.java::com.acme.shapes.Dog.loud this.name"), ["Dog.java::com.acme.shapes.Dog.name"]);
    const bare = one(calls, "Animal.java::com.acme.shapes.Animal.speak sound");
    assert.ok(bare.includes("Animal.java::com.acme.shapes.Animal.sound"));
    assert.ok(bare.includes("Dog.java::com.acme.shapes.Dog.sound (override)"));
  });

  it("resolves method references; a class without an explicit constructor has no target", () => {
    assert.deepEqual(one(calls, main("refs MathUtil::twice")), ["MathUtil.java::com.acme.util.MathUtil.twice"]);
    assert.deepEqual(one(calls, main("refs this::run")), ["Main.java::com.acme.Main.run"]);
    // `Service::new`, `new Service()`: the class declares no constructor, so there is no Function to reach.
    assert.deepEqual(one(calls, main("refs Service::new")), []);
    assert.deepEqual(one(calls, main("locals new Service")), []);
  });

  it("leaves JDK and external receivers unresolved, counted as unresolved call sites", async () => {
    for (const expression of ["external remote.doSomethingUnknown", "external Remote.staticUnknown", "refs f.apply", "refs g.apply"]) {
      assert.deepEqual(one(calls, main(expression)), [], expression);
    }
    // Without `keepCallSites` they are folded into the caller's `unresolvedCalls`.
    const compact = await buildCodeGraph(path.resolve("fixtures/java-calls"), { continueOnError: true, concurrency: 2 });
    const external = compact.nodes.find((node) => node.label === "Function" && node.id.endsWith(":com.acme.Main.external"))!;
    const unresolved = JSON.parse(String(external.properties.unresolvedCalls)) as Array<[string, number, string]>;
    assert.deepEqual(unresolved.map((site) => site[2]).sort(), ["Remote.staticUnknown", "remote.doSomethingUnknown"]);
  });

  it("adds EXTENDS and IMPLEMENTS between the classes of the scan", () => {
    assert.deepEqual(edges(result, "EXTENDS"), ["com.acme.shapes.Dog -> com.acme.shapes.Animal"]);
    assert.deepEqual(edges(result, "IMPLEMENTS"), ["com.acme.shapes.Circle -> com.acme.shapes.Shape", "com.acme.shapes.Square -> com.acme.shapes.Shape"]);
  });
});

describe("Java calls: java-packages fixture", () => {
  let result: BuildCodeGraphResult;
  let calls: Map<string, string[][]>;
  before(async () => {
    result = await scan("fixtures/java-packages");
    calls = callTargets(result);
  });

  const main = (expression: string) => `Main.java::com.acme.app.Main.main ${expression}`;

  it("resolves calls through single-type, on-demand and static imports across source roots", () => {
    assert.deepEqual(one(calls, main("new User")), ["User.java::com.acme.model.User.User"]);
    // `Address` comes in through `import com.acme.model.*`.
    assert.deepEqual(one(calls, main("u.homeAddress")), ["User.java::com.acme.model.User.homeAddress"]);
    assert.deepEqual(one(calls, main("a.street")), ["Address.java::com.acme.model.Address.street"]);
    assert.deepEqual(one(calls, main("u.getName")), ["User.java::com.acme.model.User.getName"]);
    assert.deepEqual(one(calls, main("Strings.lower")), ["Strings.java::com.acme.util.Strings.lower"]);
    assert.deepEqual(one(calls, main("upper")), ["Strings.java::com.acme.util.Strings.upper"]);
    assert.deepEqual(one(calls, main("next")), ["Ids.java::com.acme.util.Ids.next"]);
  });

  it("resolves a same-package type without an import", () => {
    assert.deepEqual(one(calls, "User.java::com.acme.model.User.homeAddress new Address"), ["Address.java::com.acme.model.Address.Address"]);
  });

  it("leaves JDK and third-party calls unresolved", () => {
    for (const expression of ["List.of", "System.out.println", "StringUtils.capitalize"]) assert.deepEqual(one(calls, main(expression)), [], expression);
    assert.deepEqual(one(calls, "User.java::com.acme.model.User.firstRole roles.get"), []);
  });
});

describe("Java calls: java-declarations fixture", () => {
  let result: BuildCodeGraphResult;
  let calls: Map<string, string[][]>;
  before(async () => {
    result = await scan("fixtures/java-declarations");
    calls = callTargets(result);
  });

  it("makes an enum constant body extend the enum and resolves enum constructors and local classes", () => {
    assert.deepEqual(edges(result, "EXTENDS"), ["com.acme.decl.Level$1 -> com.acme.decl.Level"]);
    assert.deepEqual(calls.get("Level.java::com.acme.decl.Level.<clinit> new Level"), [["Level.java::com.acme.decl.Level.Level"], ["Level.java::com.acme.decl.Level.Level"]]);
    assert.deepEqual(one(calls, "Outer.java::com.acme.decl.Outer$1.run new Local().v"), ["Outer.java::com.acme.decl.Outer.Local.v"]);
  });

  it("resolves a call inside an interface default method", () => {
    assert.deepEqual(one(calls, "Shape.java::com.acme.decl.Shape.describe area"), ["Shape.java::com.acme.decl.Shape.area"]);
  });

  it("does not guess JDK members", () => {
    assert.deepEqual(one(calls, "Level.java::com.acme.decl.Level.label name"), []);
    assert.deepEqual(one(calls, "Box.java::com.acme.decl.Box.map f.apply"), []);
  });
});

describe("Java calls: java-syntax-error fixture", () => {
  it("resolves the calls of the valid file and keeps a partial graph", async () => {
    const result = await scan("fixtures/java-syntax-error");
    const calls = callTargets(result);
    assert.deepEqual(one(calls, "Good.java::Good.after before"), ["Good.java::Good.before"]);
    assert.ok(result.nodes.some((node) => node.label === "Function" && node.id.includes("Broken.before")));
  });
});

describe("Java calls: hierarchy, nesting and constructors", () => {
  let directory: string;
  let result: BuildCodeGraphResult;
  let calls: Map<string, string[][]>;
  before(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-calls-"));
    const files: Record<string, string> = {
      "p/Base.java": `package p;
public class Base {
    protected Helper helper = new Helper();
    public Base() {}
    public Base(int x) {}
    public void hook() {}
    public static String fmt(String s, Object... rest) { return s; }
}`,
      "p/Helper.java": `package p;
public class Helper { public void assist() {} }`,
      "p/Named.java": `package p;
public interface Named { String name(); }`,
      "p/Greeter.java": `package p;
public interface Greeter extends Named { void greet(); }`,
      "p/Child.java": `package p;
import p.sub.*;
public class Child extends Base implements Greeter {
    public Child() { this(1); }
    public Child(int x) { super(x); }
    public String name() { return "c"; }
    public void greet() { helper.assist(); hook(); Child.this.hook(); }
    public void hook() { super.hook(); }
    public void make() {
        Greeter g = new Greeter() {
            public String name() { return "anon"; }
            public void greet() { Child.this.greet(); name(); }
        };
        g.greet();
        g.name();
        Base.fmt("a", 1, 2, 3);
        p.Helper h = new p.Helper();
        h.assist();
        Deep d = new Deep();
        d.go();
        Runnable r = this::hook;
        Inner.Leaf.run();
    }
    static class Inner { static class Leaf { static void run() {} } }
}`,
      "p/sub/Deep.java": `package p.sub;
public class Deep { public void go() {} }`,
      "p/Over.java": `package p;
public class Over {
    void a(int x) {}
    void a(String x) {}
    void use() { Runnable r = this::a; }
}`,
    };
    for (const [file, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await writeFile(path.join(directory, file), source);
    }
    result = await scan(directory);
    calls = callTargets(result);
  });
  after(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("links implements and anonymous classes (an interface extending an interface has no edge: EXTENDS is Class to Class)", () => {
    assert.deepEqual(edges(result, "EXTENDS"), ["p.Child -> p.Base"]);
    assert.deepEqual(edges(result, "IMPLEMENTS"), ["p.Child -> p.Greeter", "p.Child$1 -> p.Greeter"].sort());
  });

  it("resolves this(...), super(...), inherited fields, super methods and Outer.this", () => {
    assert.equal(one(calls, "Child.java::p.Child.Child this").length, 1);
    assert.ok(one(calls, "Child.java::p.Child.Child super")[0]!.startsWith("Base.java::p.Base.Base"));
    assert.deepEqual(one(calls, "Child.java::p.Child.greet helper.assist"), ["Helper.java::p.Helper.assist"]);
    assert.deepEqual(one(calls, "Child.java::p.Child.hook super.hook"), ["Base.java::p.Base.hook"]);
    assert.ok(one(calls, "Child.java::p.Child.greet Child.this.hook").includes("Child.java::p.Child.hook"));
    assert.ok(one(calls, "Child.java::p.Child$1.greet Child.this.greet").includes("Child.java::p.Child.greet"));
    assert.ok(one(calls, "Child.java::p.Child$1.greet name").includes("Child.java::p.Child$1.name"));
  });

  it("resolves a call on an interface to its implementations, including an anonymous class", () => {
    const targets = one(calls, "Child.java::p.Child.make g.greet");
    assert.ok(targets.includes("Child.java::p.Child.greet (override)"), targets.join());
    assert.ok(targets.includes("Child.java::p.Child$1.greet (override)"), targets.join());
  });

  it("finds a method an interface inherits from the interface it extends", () => {
    const targets = one(calls, "Child.java::p.Child.make g.name");
    assert.ok(targets.includes("Named.java::p.Named.name"), targets.join());
    assert.ok(targets.includes("Child.java::p.Child.name (override)"), targets.join());
    assert.ok(targets.includes("Child.java::p.Child$1.name (override)"), targets.join());
  });

  it("matches varargs, qualified and on-demand types, nested types and method references", () => {
    assert.deepEqual(one(calls, "Child.java::p.Child.make Base.fmt"), ["Base.java::p.Base.fmt"]);
    assert.deepEqual(one(calls, "Child.java::p.Child.make h.assist"), ["Helper.java::p.Helper.assist"]);
    assert.deepEqual(one(calls, "Child.java::p.Child.make d.go"), ["Deep.java::p.sub.Deep.go"]);
    assert.deepEqual(one(calls, "Child.java::p.Child.make Inner.Leaf.run"), ["Child.java::p.Child.Inner.Leaf.run"]);
    assert.deepEqual(one(calls, "Child.java::p.Child.make new p.Helper"), []);
    assert.ok(one(calls, "Child.java::p.Child.make this::hook").includes("Child.java::p.Child.hook"));
  });

  it("marks an overloaded method reference as ambiguous", () => {
    const targets = one(calls, "Over.java::p.Over.use this::a");
    assert.equal(targets.length, 2);
    assert.ok(targets.every((target) => target.endsWith("(overload)")));
  });

  it("writes every Java edge to the store", async () => {
    const store: GraphStore = await openTestStore(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-java-store-")), "graph"));
    try {
      await store.reset();
      await store.write(result.nodes, result.relationships);
      const rows = await store.query("MATCH (c:Call)-[r:CALL_RESOLVES_TO]->(f:Function) RETURN count(r) AS n");
      assert.ok(Number(rows[0]!.n) > 5);
    } finally {
      await store.close();
    }
  });
});

describe("Java calls: captured locals", () => {
  it("resolves a local captured by an anonymous or local class before a same-named field", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-capture-"));
    try {
      await mkdir(path.join(dir, "a"), { recursive: true });
      await writeFile(path.join(dir, "a/Cap.java"), [
        "package a;",
        "class Cap {",
        "  Other h;",
        "  Other u;",
        "  void make() {",
        "    Helper h = new Helper();",
        "    new Thread() { public void run() { h.go(); } };",
        "  }",
        "  void local() {",
        "    Helper u = new Helper();",
        "    class L { void run() { u.go(); } }",
        "  }",
        "  void unknown(java.util.List<Helper> items) {",
        "    var h = items.get(0);",
        "    new Thread() { public void run() { h.go(); } };",
        "  }",
        "  void field() {",
        "    new Thread() { public void run() { u.go(); } };",
        "  }",
        "}",
        "",
      ].join("\n"));
      await writeFile(path.join(dir, "a/Helper.java"), "package a;\nclass Helper { void go() {} }\n");
      await writeFile(path.join(dir, "a/Other.java"), "package a;\nclass Other { void go() {} }\n");
      const calls = callTargets(await scan(dir));
      const all = [...calls.entries()].filter(([key]) => key.endsWith(" h.go") || key.endsWith(" u.go"));
      const flat = all.map(([key, value]) => `${key} => ${value.map((v) => v.join(",")).join("|")}`);
      // anonymous class capturing h, local class capturing u: Helper.go
      assert.ok(flat.some((line) => line.includes("h.go => Helper.java::a.Helper.go")), flat.join("\n"));
      assert.ok(flat.some((line) => line.includes("u.go => Helper.java::a.Helper.go")), flat.join("\n"));
      // captured local of unknown type: unresolved, never Other.go; a real field still resolves to the field
      const resolved = flat.filter((line) => line.includes("Other.go"));
      assert.equal(resolved.length, 1, flat.join("\n"));
      assert.ok(resolved[0]!.includes("u.go"), flat.join("\n"));
      assert.ok(flat.some((line) => /h\.go => $/u.test(line)), flat.join("\n"));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

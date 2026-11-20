import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import type { GraphNode, ParsedSourceFile } from "../src/core/graph/model.js";
import { defaultLanguageTable } from "../src/composition/default-registry.js";
import { isJavaFile } from "../src/integrations/languages/file-kind.js";
import { javaParser } from "../src/integrations/languages/java/parser.js";
import { normalizeJavaType } from "../src/integrations/languages/java/syntax.js";

let root: string;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-"));
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function parse(relativePath: string, source: string): Promise<ParsedSourceFile> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, source);
  return javaParser.parse(root, file);
}

const byLabel = (parsed: ParsedSourceFile, label: string) => parsed.nodes.filter((node) => node.label === label);
const named = (parsed: ParsedSourceFile, label: string, qualifiedName: string): GraphNode => {
  const node = parsed.nodes.find((candidate) => candidate.label === label && candidate.properties.qualifiedName === qualifiedName);
  assert.ok(node, `${label} ${qualifiedName}`);
  return node;
};
const calls = (parsed: ParsedSourceFile, expression: string) => byLabel(parsed, "Call").filter((node) => node.properties.expression === expression);
const related = (parsed: ParsedSourceFile, type: string, from: GraphNode) =>
  parsed.relationships.filter((relationship) => relationship.type === type && relationship.from === from.id).map((relationship) => parsed.nodes.find((node) => node.id === relationship.to)!);

const SAMPLE = `package com.acme.model;

import java.util.*;
import java.util.List;
import static java.lang.Math.max;
import static org.junit.Assert.*;

@Deprecated
public abstract class Outer<T, K extends Comparable<K>> extends Base<T> implements Runnable, Foo.Bar {
  private final List<String> names = new ArrayList<>();
  static int counter = 1;
  static { setup(); }
  @Inject @Named("x") Svc svc;

  public Outer(int x, String... rest) { this(x); super.start(); }

  @Override
  protected <U> U get(final Map<String, U> m, int[] arr) {
    var z = new Thing(1);
    Foo f = (Foo) other;
    names.forEach(this::run);
    Supplier<Foo> s = Foo::new;
    Runnable r = () -> doIt(z);
    new Helper().go();
    f.bar();
    Util.make(1, 2);
    Object o = new Runnable() { public void run() { inner(); } };
    class Loc { void m() {} }
    return null;
  }

  interface I extends A, B<String> { int X = 1; void m(); default void d() {} static void s() {} }
  enum E implements I { A(1), B { void m() {} }; E(int i) {} public void m() {} }
  record R(int a, String b) implements I { R { check(); } static R of() { return new R(1, ""); } public void m() {} }
  @interface Ann { String value() default "x"; }
  class Inner { }
  static class Nested { }
}
`;

describe("Java language descriptor", () => {
  it("claims .java files, module-info and package-info included", () => {
    for (const file of ["A.java", "src/main/java/module-info.java", "p/package-info.java"]) {
      assert.equal(defaultLanguageTable.detect(file), "java", file);
      assert.equal(isJavaFile(file), true, file);
    }
    assert.equal(isJavaFile("a.kt"), false);
  });

  it("normalizes written types", () => {
    assert.equal(normalizeJavaType("java.util.Map.Entry<K, V>"), "java.util.Map.Entry");
    assert.equal(normalizeJavaType("@Nullable Foo[]"), "Foo[]");
    assert.equal(normalizeJavaType("final List<List<String>>"), "List");
    assert.equal(normalizeJavaType("String..."), "String[]");
    assert.equal(normalizeJavaType("var"), null);
    assert.equal(normalizeJavaType("? extends Foo"), null);
  });
});

describe("Java parser", () => {
  let parsed: ParsedSourceFile;
  before(async () => {
    parsed = await parse("src/main/java/com/acme/model/Outer.java", SAMPLE);
  });

  it("records the file, its package and imports", () => {
    const file = parsed.nodes[0]!;
    assert.equal(file.label, "File");
    assert.equal(file.properties.language, "java");
    assert.equal(file.properties.packageName, "com.acme.model");
    const imports = byLabel(parsed, "Import").map((node) => [node.properties.source, node.properties.isWildcard, node.properties.isStatic]);
    assert.deepEqual(imports, [
      ["java.util", true, false],
      ["java.util.List", false, false],
      ["java.lang.Math.max", false, true],
      ["org.junit.Assert", true, true],
    ]);
    assert.equal(parsed.relationships.filter((relationship) => relationship.type === "IMPORTS").length, 4);
  });

  it("marks module-info and package-info files", async () => {
    const module = await parse("module-info.java", "module com.acme.app { requires java.base; }\n");
    assert.equal(module.nodes[0]!.properties.javaFileKind, "module-info");
    assert.equal(module.nodes[0]!.properties.javaModule, "com.acme.app");
    const info = await parse("com/acme/package-info.java", "@Deprecated\npackage com.acme;\n");
    assert.equal(info.nodes[0]!.properties.javaFileKind, "package-info");
    assert.equal(info.nodes[0]!.properties.packageName, "com.acme");
    assert.equal(parsed.nodes[0]!.properties.javaFileKind, undefined);
  });

  it("reads classes with Java-style qualified names, supertypes and type parameters", () => {
    const outer = named(parsed, "Class", "com.acme.model.Outer");
    assert.equal(outer.properties.kind, "class");
    assert.equal(outer.properties.isAbstract, true);
    assert.equal(outer.properties.visibility, "public");
    assert.equal(outer.properties.nesting, "top-level");
    assert.deepEqual(JSON.parse(String(outer.properties.typeParameters)), ["T", "K extends Comparable<K>"]);
    assert.deepEqual(JSON.parse(String(outer.properties.extendsNames)), ["Base"]);
    assert.deepEqual(JSON.parse(String(outer.properties.implementsNames)), ["Runnable", "Foo.Bar"]);
    assert.deepEqual(JSON.parse(String(outer.properties.bases))[0], { name: "Base", text: "Base<T>", relation: "extends" });
  });

  it("reads nested, inner, local and anonymous types", () => {
    assert.equal(named(parsed, "Class", "com.acme.model.Outer.Inner").properties.nesting, "inner");
    assert.equal(named(parsed, "Class", "com.acme.model.Outer.Nested").properties.nesting, "static");
    assert.equal(named(parsed, "Class", "com.acme.model.Outer.Loc").properties.nesting, "local");
    const anonymous = named(parsed, "Class", "com.acme.model.Outer$1");
    assert.equal(anonymous.properties.nesting, "anonymous");
    assert.deepEqual(JSON.parse(String(anonymous.properties.extendsNames)), ["Runnable"]);
    assert.equal(anonymous.properties.isExported, false);
    assert.equal(named(parsed, "Class", "com.acme.model.Outer.Inner").properties.outer, "com.acme.model.Outer");
  });

  it("reads interfaces, enums, records and annotation types", () => {
    const iface = named(parsed, "Interface", "com.acme.model.Outer.I");
    assert.equal(iface.properties.kind, "interface");
    assert.deepEqual(JSON.parse(String(iface.properties.embeds)), ["A", "B"]);
    assert.deepEqual(JSON.parse(String(iface.properties.methods)), ["m", "d", "s"]);
    const methods = related(parsed, "DEFINES_INTERFACE_METHOD", iface);
    assert.deepEqual(methods.map((method) => [method.properties.name, method.properties.visibility, method.properties.isAbstract, method.properties.isStatic]), [
      ["m", "public", true, false], ["d", "public", false, false], ["s", "public", false, true],
    ]);
    assert.equal(related(parsed, "DEFINES_INTERFACE_FIELD", iface)[0]!.properties.name, "X");

    const enumeration = named(parsed, "Class", "com.acme.model.Outer.E");
    assert.equal(enumeration.properties.kind, "enum");
    assert.deepEqual(related(parsed, "DEFINES_FIELD", enumeration).map((field) => [field.properties.name, field.properties.fieldKind]), [["A", "enum-constant"], ["B", "enum-constant"]]);
    assert.equal(named(parsed, "Function", "com.acme.model.Outer.E.E").properties.visibility, "private");
    assert.equal(named(parsed, "Class", "com.acme.model.Outer.E$1").properties.nesting, "anonymous");
    assert.equal(calls(parsed, "new E").length, 2);

    const record = named(parsed, "Class", "com.acme.model.Outer.R");
    assert.equal(record.properties.kind, "record");
    assert.deepEqual(related(parsed, "DEFINES_FIELD", record).map((field) => [field.properties.name, field.properties.typeName, field.properties.fieldKind]), [
      ["a", "int", "record-component"], ["b", "String", "record-component"],
    ]);
    const compact = named(parsed, "Function", "com.acme.model.Outer.R.R");
    assert.equal(compact.properties.methodKind, "compact");
    assert.equal(compact.properties.parameterCount, 2);

    assert.equal(named(parsed, "Interface", "com.acme.model.Outer.Ann").properties.kind, "annotation");
  });

  it("reads fields, constructors and methods with visibility, static and signatures", () => {
    const outer = named(parsed, "Class", "com.acme.model.Outer");
    const fields = Object.fromEntries(related(parsed, "DEFINES_FIELD", outer).map((field) => [field.properties.name, field.properties]));
    assert.equal(fields.names!.typeName, "List");
    assert.equal(fields.names!.declaredType, "List<String>");
    assert.equal(fields.names!.visibility, "private");
    assert.equal(fields.names!.isReadonly, true);
    assert.equal(fields.counter!.isStatic, true);
    assert.equal(fields.svc!.visibility, "package");

    const constructor = named(parsed, "Function", "com.acme.model.Outer.Outer");
    assert.equal(constructor.properties.kind, "constructor");
    assert.equal(constructor.properties.visibility, "public");
    assert.deepEqual(JSON.parse(String(constructor.properties.parameters)), [{ name: "x", type: "int" }, { name: "rest", type: "String[]", varargs: true }]);

    const get = named(parsed, "Function", "com.acme.model.Outer.get");
    assert.equal(get.properties.visibility, "protected");
    assert.equal(get.properties.returnType, "U");
    assert.equal(get.properties.parameterCount, 2);
    assert.equal(get.properties.className, "Outer");
    assert.deepEqual(JSON.parse(String(get.properties.typeParameters)), ["U"]);
    assert.equal(related(parsed, "DEFINES_METHOD", named(parsed, "Class", "com.acme.model.Outer")).includes(get), true);
  });

  it("links annotations to classes, methods and fields with their arguments", () => {
    const outer = named(parsed, "Class", "com.acme.model.Outer");
    assert.deepEqual(related(parsed, "HAS_DECORATOR", outer).map((node) => node.properties.name), ["Deprecated"]);
    const get = named(parsed, "Function", "com.acme.model.Outer.get");
    assert.deepEqual(related(parsed, "HAS_METHOD_DECORATOR", get).map((node) => node.properties.name), ["Override"]);
    const svc = related(parsed, "DEFINES_FIELD", outer).find((field) => field.properties.name === "svc")!;
    const decorators = related(parsed, "FIELD_HAS_DECORATOR", svc);
    assert.deepEqual(decorators.map((node) => node.properties.name), ["Inject", "Named"]);
    assert.deepEqual(JSON.parse(String(decorators[1]!.properties.args)), ['"x"']);
    assert.equal(decorators[1]!.properties.expression, '@Named("x")');
  });

  it("records the declared types of parameters and locals per function", () => {
    const get = named(parsed, "Function", "com.acme.model.Outer.get");
    const locals = JSON.parse(String(get.properties.javaLocals)) as Record<string, { type: string } | null>;
    assert.deepEqual(locals.m, { type: "Map" });
    assert.deepEqual(locals.arr, { type: "int[]" });
    assert.deepEqual(locals.z, { type: "Thing" });
    assert.deepEqual(locals.f, { type: "Foo" });
    assert.deepEqual(locals.s, { type: "Supplier" });
  });

  it("reads method calls with receivers, qualifiers and argument counts", () => {
    const local = calls(parsed, "f.bar")[0]!.properties;
    assert.equal(local.callee, "bar");
    assert.equal(local.receiver, "f");
    assert.equal(local.receiverIsLocal, true);
    assert.equal(local.receiverType, "Foo");
    assert.equal(local.callKind, "method");
    assert.equal(local.argumentCount, 0);

    const staticCall = calls(parsed, "Util.make")[0]!.properties;
    assert.equal(staticCall.qualifier, "Util");
    assert.equal(staticCall.argumentCount, 2);

    assert.equal(calls(parsed, "super.start")[0]!.properties.receiver, "super");
    assert.equal(calls(parsed, "names.forEach")[0]!.properties.qualifier, "names");
    assert.equal(calls(parsed, "new Helper().go")[0]!.properties.receiverConstructor, "Helper");
    assert.equal(calls(parsed, "doIt")[0]!.properties.callKind, "method");
  });

  it("reads constructor calls, explicit constructor calls and method references", () => {
    const created = calls(parsed, "new Thing")[0]!.properties;
    assert.equal(created.callKind, "constructor");
    assert.equal(created.callee, "Thing");
    assert.equal(created.argumentCount, 1);
    assert.equal(calls(parsed, "this")[0]!.properties.callKind, "explicitConstructor");
    assert.equal(calls(parsed, "this::run")[0]!.properties.callKind, "methodReference");
    assert.equal(calls(parsed, "this::run")[0]!.properties.receiver, "this");
    const reference = calls(parsed, "Foo::new")[0]!.properties;
    assert.equal(reference.callKind, "constructorReference");
    assert.equal(reference.qualifier, "Foo");
  });

  it("attaches calls of anonymous classes and initializers to their own functions", () => {
    const inner = calls(parsed, "inner")[0]!;
    const owner = parsed.relationships.find((relationship) => relationship.type === "CALLS" && relationship.to === inner.id)!;
    assert.match(owner.from, /Outer\$1\.run$/u);
    const initializer = named(parsed, "Function", "com.acme.model.Outer.<clinit>");
    assert.equal(initializer.properties.kind, "initializer");
    assert.equal(related(parsed, "CALLS", initializer)[0]!.properties.callee, "setup");
    const instance = named(parsed, "Function", "com.acme.model.Outer.<init-block>");
    assert.equal(related(parsed, "CALLS", instance)[0]!.properties.expression, "new ArrayList");
  });

  it("gives every node a unique id", () => {
    const ids = parsed.nodes.map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("keeps a partial graph and warns when a file has syntax errors", async () => {
    const broken = await parse("Broken.java", `package p;
public class Broken {
  public void good() { helper(); }
  public void bad() {
    int = ;
    kept();
  }
  public void alsoGood() { other(); }
}
`);
    assert.ok(broken.warnings?.[0]?.startsWith("Syntax error: left out"), String(broken.warnings));
    const names = byLabel(broken, "Function").map((node) => node.properties.name);
    assert.ok(names.includes("good"));
    assert.ok(names.includes("alsoGood"));
    assert.ok(names.includes("bad"));
    assert.equal(calls(broken, "kept").length, 1);
  });

  it("uses the default package when there is none", async () => {
    const plain = await parse("Plain.java", "class Plain { void run() {} }\n");
    assert.equal(named(plain, "Class", "Plain").properties.visibility, "package");
    assert.equal(plain.nodes[0]!.properties.packageName, undefined);
  });
});

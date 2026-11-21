import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { GraphBuilder } from "../src/core/graph/builder.js";
import { withSyntaxTree, type SyntaxNode } from "../src/integrations/languages/syntax/tree-sitter.js";
import {
  createJavaStringResolver,
  javaLocalNames,
  javaStringFromText,
  javaStringLiteralValue,
  readJavaString,
  readLocalStrings,
  renderJavaString,
  type JavaStringTemplate,
} from "../src/integrations/frameworks/java/strings.js";

// The template of the initializer of `Object x = <expression>;` in a method of a wrapper class.
async function render(expression: string, before = ""): Promise<string | null> {
  const source = `class A { void m(String id, int n) { ${before} Object x = ${expression}; } }`;
  return withSyntaxTree("java", source, (tree) => {
    const declarations: SyntaxNode[] = [];
    const stack: SyntaxNode[] = [tree.rootNode];
    while (stack.length > 0) {
      const node = stack.pop()!;
      if (node.type === "variable_declarator" && node.childForFieldName("name")?.text === "x") declarations.push(node);
      stack.push(...node.namedChildren);
    }
    const body = tree.rootNode.descendantsOfType("block")[0]!;
    const locals = readLocalStrings([body]);
    const template = readJavaString(declarations[0]!.childForFieldName("value")!, { locals });
    return template ? renderJavaString(template) : null;
  });
}

// The parts of the initializer of `Object x` in method `m` of `source`.
async function partsOfX(source: string): Promise<JavaStringTemplate | null> {
  return withSyntaxTree("java", source, (tree) => {
    const method = tree.rootNode.descendantsOfType("method_declaration").find((node) => node.childForFieldName("name")?.text === "m")!;
    const body = method.childForFieldName("body")!;
    const initializer = body.descendantsOfType("variable_declarator").find((node) => node.childForFieldName("name")?.text === "x")!;
    const dynamic = javaLocalNames([body]);
    return readJavaString(initializer.childForFieldName("value")!, { locals: readLocalStrings([body], dynamic), dynamic });
  });
}

async function scan(files: Record<string, string>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-strings-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    const graph = await buildCodeGraph(dir, { continueOnError: false });
    const builder = new GraphBuilder();
    builder.addNodes(graph.nodes);
    builder.addRelationships(graph.relationships);
    return builder;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Java string templates at parse time", () => {
  it("reads literals, concatenation, escapes and text blocks", async () => {
    assert.equal(await render('"/users"'), "/users");
    assert.equal(await render('"/a/" + "b" + "/c"'), "/a/b/c");
    assert.equal(await render('"line\\n\\"q\\" \\u0041"'), 'line\n"q" A');
    assert.equal(await render('("a" + ("b" + "c"))'), "abc");
    assert.equal(await render('"v" + 2'), "v2");
    assert.equal(await render('(String) "x"'), "x");
    assert.equal(await render('"""\n        select *\n          from t\n        """'), "select *\n  from t\n");
    assert.equal(await render('"""\n        a \\\n        b"""'), "a b");
  });

  it("writes dynamic parts as ${expression}", async () => {
    assert.equal(await render('"/users/" + id'), "/users/${id}");
    assert.equal(await render('"/users/" + id + "/posts/" + n'), "/users/${id}/posts/${n}");
    assert.equal(await render("id.trim() + n"), "${id}${n}");
    assert.equal(await render('"/u/" + user.getId() + "/x"'), "/u/${user.getId()}/x");
    assert.match((await render('"/u/" + (n > 1 ? "a" : "b")'))!, /^\/u\/\$\{n_>_1_/u);
  });

  it("returns null when nothing literal is known", async () => {
    assert.equal(await render("compute(id)"), null);
    assert.equal(await render("n > 1 ? id : id"), null);
  });

  it("reads String.format, formatted, valueOf, join and concat", async () => {
    assert.equal(await render('String.format("/users/%s/posts/%d", id, n)'), "/users/${id}/posts/${n}");
    assert.equal(await render('String.format("%2$s-%1$s 100%%", "a", id)'), "${id}-a 100%");
    assert.equal(await render('"/u/%s".formatted(id)'), "/u/${id}");
    assert.equal(await render('"/u/%s".formatted("x")'), "/u/x");
    assert.equal(await render('"/u/" + String.valueOf(id)'), "/u/${id}");
    assert.equal(await render('String.join("/", "a", id, "b")'), "a/${id}/b");
    assert.equal(await render('"a".concat("b")'), "ab");
    assert.equal(await render("String.format(pattern, id)"), null);
  });

  it("reads single-assignment locals", async () => {
    assert.equal(await render('url + "/x"', 'String url = "http://h/" + id;'), "http://h/${id}/x");
    // Reassigned or declared twice: not a constant, the name stays a placeholder.
    assert.equal(await render('url + "/x"', 'String url = "a"; url = "b";'), "${url}/x");
    assert.equal(await render('url + "/x"', 'String url = "a"; if (n > 0) { String url = "b"; }'), "${url}/x");
    assert.equal(await render('b + "!"', 'final var a = "x"; var b = a + "y";'), "xy!");
  });

  it("never takes a parameter or a local for a constant of the same name", async () => {
    // A field named like the name used stays a `ref`; parameters and locals are `expr`.
    const source = (signature: string, body: string) => `class A { static final String BASE = "/v1"; void m(${signature}) { ${body} } }`;
    assert.deepEqual(await partsOfX(source("int n", "Object x = BASE + \"/a\";")), [{ ref: "BASE" }, { text: "/a" }]);
    assert.deepEqual(await partsOfX(source("String BASE", "Object x = BASE + \"/a\";")), [{ expr: "BASE" }, { text: "/a" }]);
    assert.deepEqual(await partsOfX(source("String... BASE", "Object x = BASE + \"/a\";")), [{ expr: "BASE" }, { text: "/a" }]);
    assert.deepEqual(await partsOfX(source("int n", "String BASE = compute(); Object x = BASE + \"/a\";")), [{ expr: "BASE" }, { text: "/a" }]);
    assert.deepEqual(await partsOfX(source("int n", "String BASE = \"a\"; BASE = \"b\"; Object x = BASE + \"/a\";")), [{ expr: "BASE" }, { text: "/a" }]);
    assert.deepEqual(await partsOfX(source("java.util.List<String> l", "for (String BASE : l) { Object x = BASE + \"/a\"; }")), [{ expr: "BASE" }, { text: "/a" }]);
    assert.deepEqual(await partsOfX(source("java.util.List<String> l", "l.forEach(BASE -> { Object x = BASE + \"/a\"; });")), [{ expr: "BASE" }, { text: "/a" }]);
    // A single-assignment literal local is its value.
    assert.deepEqual(await partsOfX(source("int n", "String BASE = \"/local\"; Object x = BASE + \"/a\";")), [{ text: "/local/a" }]);
  });

  it("reads boolean constants", async () => {
    const graph = await scan({ "src/main/java/A.java": `class A { static final boolean NATIVE = true; static final Boolean OFF = false; }` });
    const constants = graph.nodesWithLabel("Field").map((field) => `${field.properties.name}=${String(field.properties.stringConstant)}`).sort();
    assert.deepEqual(constants, ['NATIVE=[{"text":"true"}]', 'OFF=[{"text":"false"}]']);
  });

  it("reads a string kept as text, as annotation arguments are", () => {
    const text = (expression: string) => {
      const template = javaStringFromText(expression);
      return template ? renderJavaString(template) : null;
    };
    assert.equal(text('"/api/" + "v1"'), "/api/v1");
    assert.equal(text('Urls.BASE + "/x"'), "${Urls.BASE}/x");
    assert.equal(text('("a" + "b")'), "ab");
    assert.equal(text("compute(x)"), null);
    assert.equal(javaStringLiteralValue('"a\\tb"'), "a\tb");
    assert.equal(javaStringLiteralValue("a"), null);
  });
});

describe("Java string constants once every file is parsed", () => {
  const files = {
    "src/main/java/com/acme/Urls.java": `package com.acme;
public final class Urls {
  public static final String HOST = "http://api.example.com";
  public static final String BASE = HOST + "/v1";
  public static final int PORT = 8080;
  public static final String LOOP = LOOP2 + "x";
  public static final String LOOP2 = LOOP + "y";
  static final String DYNAMIC = System.getenv("X");
  public static class Paths { public static final String USERS = "/users"; }
}
`,
    "src/main/java/com/acme/Constants.java": `package com.acme;
public interface Constants { String PREFIX = "/api"; }
`,
    "src/main/java/com/acme/Base.java": `package com.acme;
public class Base { protected static final String INHERITED = "/inherited"; }
`,
    "src/main/java/com/acme/Client.java": `package com.acme;
import static com.acme.Urls.BASE;
import static com.acme.Urls.Paths.*;
import com.other.External;
public class Client extends Base implements Constants {
  private static final String LOCAL = "/local";
  private final String instance = "inst";
  static class Inner { String run() { return LOCAL + Urls.PORT; } }
  void run() { String s = LOCAL + BASE + USERS + Urls.Paths.USERS + PREFIX + INHERITED + instance + External.X + Urls.LOOP + Urls.DYNAMIC + com.acme.Urls.HOST; }
}
`,
  };

  async function resolveInitializer(graph: GraphBuilder, className: string, expression: string): Promise<string | null> {
    const client = graph.nodesWithLabel("Class").find((node) => node.properties.qualifiedName === className)!;
    const fileId = [...graph.relationshipsOfType("DEFINES_CLASS")].find((rel) => rel.to === client.id)!.from;
    const template = javaStringTextToTemplate(expression);
    return createJavaStringResolver(graph).resolve(template, { fileId, typeId: client.id });
  }
  const javaStringTextToTemplate = (expression: string): JavaStringTemplate => javaStringFromText(expression)!;

  it("keeps constants on Field nodes", async () => {
    const graph = await scan(files);
    const constants = graph.nodesWithLabel("Field").filter((field) => field.properties.stringConstant !== undefined).map((field) => `${field.properties.name}=${String(field.properties.stringConstant)}`).sort();
    assert.ok(constants.includes('BASE=[{"ref":"HOST"},{"text":"/v1"}]'));
    assert.ok(constants.includes('PORT=[{"text":"8080"}]'));
    assert.ok(constants.includes('PREFIX=[{"text":"/api"}]'));
    assert.ok(constants.includes('instance=[{"text":"inst"}]'));
    assert.ok(!constants.some((constant) => constant.startsWith("DYNAMIC=")), "a call is no constant");
  });

  it("resolves constants of the class, outer classes, other files, static imports and supertypes", async () => {
    const graph = await scan(files);
    assert.equal(await resolveInitializer(graph, "com.acme.Client", "LOCAL"), "/local");
    assert.equal(await resolveInitializer(graph, "com.acme.Client", "instance"), "inst");
    assert.equal(await resolveInitializer(graph, "com.acme.Client", "this.instance"), "inst");
    assert.equal(await resolveInitializer(graph, "com.acme.Client", 'BASE + "/x"'), "http://api.example.com/v1/x");
    assert.equal(await resolveInitializer(graph, "com.acme.Client", "USERS"), "/users");
    assert.equal(await resolveInitializer(graph, "com.acme.Client", "Urls.Paths.USERS"), "/users");
    assert.equal(await resolveInitializer(graph, "com.acme.Client", "com.acme.Urls.HOST"), "http://api.example.com");
    assert.equal(await resolveInitializer(graph, "com.acme.Client", 'PREFIX + INHERITED'), "/api/inherited");
    assert.equal(await resolveInitializer(graph, "com.acme.Client", 'Urls.PORT + "x"'), "8080x");
    // From a nested class the outer class's constants are in scope.
    assert.equal(await resolveInitializer(graph, "com.acme.Client.Inner", 'LOCAL + "/i"'), "/local/i");
  });

  it("keeps unknown names and cycles as ${name}", async () => {
    const graph = await scan(files);
    assert.equal(await resolveInitializer(graph, "com.acme.Client", 'External.X + "/x"'), "${External.X}/x");
    assert.equal(await resolveInitializer(graph, "com.acme.Client", "Urls.DYNAMIC"), null);
    assert.equal(await resolveInitializer(graph, "com.acme.Client", 'Urls.LOOP + "!"'), "${LOOP2}xyx!");
    const client = graph.nodesWithLabel("File").find((node) => String(node.properties.relativePath).endsWith("Client.java"))!;
    assert.deepEqual(createJavaStringResolver(graph).constant("Urls.BASE", { fileId: client.id }), [{ text: "http://api.example.com/v1" }]);
    assert.equal(createJavaStringResolver(graph).constant("Urls.MISSING", { fileId: client.id }), null);
  });
});

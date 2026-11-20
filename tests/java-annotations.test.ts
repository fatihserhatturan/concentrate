import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { GraphBuilder } from "../src/core/graph/builder.js";
import type { GraphNode } from "../src/core/graph/model.js";
import {
  addJavaEntryPoint,
  addJavaRoute,
  annotationEnum,
  annotationValue,
  findAnnotations,
  hasAnnotation,
  javaAnnotationReader,
  joinRoutePath,
} from "../src/integrations/frameworks/java/annotations.js";
import { openTestStore } from "./helpers/store.js";

const SOURCES: Record<string, string> = {
  "src/main/java/com/acme/UserController.java": `package com.acme;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.beans.factory.annotation.Qualifier;
import com.acme.PostMapping;

@RequestMapping("/api")
public class UserController {
  @org.springframework.web.bind.annotation.DeleteMapping(path = {"/a b", "/c"})
  public void delete() {}

  @GetMapping(value = "users/{id}")
  public String get(@Qualifier("primary") String name, int plain, @Qualifier(value = "x") @Deprecated String... rest) { return name; }

  @RequestMapping(method = {RequestMethod.GET, POST}, path = BASE + "/x")
  public void many() {}

  @PostMapping("/mine")
  public void mine() {}

  @GetMapping({"/p", "/q"})
  public void paths() {}

  @Qualifier("field")
  private String field;
}
`,
  "src/main/java/com/acme/Svc.java": `package com.acme;

public interface Svc {
  @javax.annotation.Nullable
  String find();
}
`,
};

let root: string;
let graph: GraphBuilder;
before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-annotations-"));
  for (const [file, source] of Object.entries(SOURCES)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), source);
  }
  const result = await buildCodeGraph(root, { continueOnError: false });
  graph = new GraphBuilder();
  graph.addNodes(result.nodes);
  graph.addRelationships(result.relationships);
});
after(async () => {
  await rm(root, { recursive: true, force: true });
});

const find = (label: string, qualifiedName: string): GraphNode => {
  const node = graph.nodes.find((candidate) => candidate.label === label && candidate.properties.qualifiedName === qualifiedName);
  assert.ok(node, `${label} ${qualifiedName}`);
  return node;
};
const FILE = "file:src/main/java/com/acme/UserController.java";

describe("parameter annotations", () => {
  it("keeps name and args per parameter and omits the key for plain parameters", () => {
    const parameters = JSON.parse(String(find("Function", "com.acme.UserController.get").properties.parameters));
    assert.deepEqual(parameters, [
      { name: "name", type: "String", annotations: [{ name: "Qualifier", args: ['"primary"'] }] },
      { name: "plain", type: "int" },
      { name: "rest", type: "String[]", varargs: true, annotations: [{ name: "Qualifier", args: ['value="x"'] }, { name: "Deprecated", args: [] }] },
    ]);
  });
});

describe("annotation reader", () => {
  it("reads class, method, interface method and field annotations with simple and qualified names", () => {
    const reader = javaAnnotationReader(graph);
    const [mapping] = reader.annotationsOf(find("Class", "com.acme.UserController"));
    assert.equal(mapping!.simpleName, "RequestMapping");
    assert.equal(mapping!.qualifiedName, "org.springframework.web.bind.annotation.RequestMapping");
    assert.deepEqual(mapping!.args, ['"/api"']);
    assert.equal(mapping!.line, 9);

    const [qualified] = reader.annotationsOf(find("Function", "com.acme.UserController.delete"));
    assert.equal(qualified!.name, "org.springframework.web.bind.annotation.DeleteMapping");
    assert.equal(qualified!.simpleName, "DeleteMapping");
    assert.equal(qualified!.qualifiedName, qualified!.name);

    const [field] = reader.annotationsOf(graph.nodes.find((node) => node.label === "Field" && node.properties.name === "field")!);
    assert.equal(field!.qualifiedName, "org.springframework.beans.factory.annotation.Qualifier");

    const [nullable] = reader.annotationsOf(find("Function", "com.acme.Svc.find"));
    assert.equal(nullable!.simpleName, "Nullable");
    assert.equal(reader.annotationsOf("nope").length, 0);
  });

  it("matches package prefixes only when the package is known", () => {
    const reader = javaAnnotationReader(graph);
    const spring = ["org.springframework.web.bind.annotation"];
    const get = reader.annotationsOf(find("Function", "com.acme.UserController.get"));
    assert.equal(hasAnnotation(get, "GetMapping", spring), true);
    assert.equal(hasAnnotation(get, "GetMapping"), true);
    assert.equal(hasAnnotation(get, "PostMapping", spring), false);
    // The user's own PostMapping (import com.acme.PostMapping) is not Spring's.
    const mine = reader.annotationsOf(find("Function", "com.acme.UserController.mine"));
    assert.equal(mine[0]!.qualifiedName, "com.acme.PostMapping");
    assert.equal(hasAnnotation(mine, "PostMapping", spring), false);
    assert.equal(hasAnnotation(mine, "PostMapping", ["com.acme"]), true);
    assert.equal(findAnnotations(get, "GetMapping", ["org.springframework.web.bind.annotation.GetMapping"]).length, 1);
    // Prefixes match whole package segments.
    assert.equal(hasAnnotation(get, "GetMapping", ["org.spring"]), false);
  });
});

describe("annotation arguments", () => {
  const ann = (...args: string[]) => ({ args });

  it("reads @X(\"a\"), value=, path={...} and positional arrays", () => {
    assert.deepEqual(annotationValue(ann('"a"')), [{ value: "a", resolved: true }]);
    assert.deepEqual(annotationValue(ann('value="a"')), [{ value: "a", resolved: true }]);
    assert.deepEqual(annotationValue(ann('path={"a","b"}'), "path"), [{ value: "a", resolved: true }, { value: "b", resolved: true }]);
    assert.deepEqual(annotationValue(ann('{"a","b"}')), [{ value: "a", resolved: true }, { value: "b", resolved: true }]);
    assert.equal(annotationValue(ann('"a"', 'produces="x"')), null);
    assert.equal(annotationValue(ann('produces="x"')), null);
    assert.equal(annotationValue(ann()), null);
    assert.deepEqual(annotationValue(ann('value="a,b"')), [{ value: "a,b", resolved: true }]);
    assert.deepEqual(annotationValue(ann('"a\\"b\\n"')), [{ value: 'a"b\n', resolved: true }]);
  });

  it("flags constants and non-literal concatenations as unresolved, resolves literal concatenation", () => {
    assert.deepEqual(annotationValue(ann("BASE")), [{ value: "BASE", resolved: false }]);
    assert.deepEqual(annotationValue(ann('path=BASE+"/x"'), "path"), [{ value: 'BASE+"/x"', resolved: false }]);
    assert.deepEqual(annotationValue(ann('"/a"+"/b"')), [{ value: "/a/b", resolved: true }]);
    assert.deepEqual(annotationValue(ann('{"/a",Paths.B}')), [{ value: "/a", resolved: true }, { value: "Paths.B", resolved: false }]);
  });

  it("reads enum arguments as simple names", () => {
    assert.deepEqual(annotationEnum(ann("method=RequestMethod.GET"), "method"), ["GET"]);
    assert.deepEqual(annotationEnum(ann("method={RequestMethod.GET,POST}"), "method"), ["GET", "POST"]);
    assert.equal(annotationEnum(ann('value="x"'), "method"), null);
  });

  it("reads the arguments the parser produced, strings with spaces intact", () => {
    const reader = javaAnnotationReader(graph);
    const [deleted] = reader.annotationsOf(find("Function", "com.acme.UserController.delete"));
    assert.deepEqual(annotationValue(deleted!, "path"), [{ value: "/a b", resolved: true }, { value: "/c", resolved: true }]);
    const [many] = reader.annotationsOf(find("Function", "com.acme.UserController.many"));
    assert.deepEqual(annotationEnum(many!, "method"), ["GET", "POST"]);
    assert.deepEqual(annotationValue(many!, "path"), [{ value: 'BASE+"/x"', resolved: false }]);
    const [paths] = reader.annotationsOf(find("Function", "com.acme.UserController.paths"));
    assert.deepEqual(annotationValue(paths!)!.map((v) => v.value), ["/p", "/q"]);
  });
});

describe("joinRoutePath", () => {
  it("joins with single slashes and a leading slash", () => {
    assert.equal(joinRoutePath("/api", "users/{id}"), "/api/users/{id}");
    assert.equal(joinRoutePath("api/", "/users/"), "/api/users");
    assert.equal(joinRoutePath("", ""), "/");
    assert.equal(joinRoutePath("/", "/"), "/");
    assert.equal(joinRoutePath("/api", ""), "/api");
    assert.equal(joinRoutePath(undefined, "x"), "/x");
    assert.equal(joinRoutePath(null, undefined), "/");
    assert.equal(joinRoutePath("/a//b", "c"), "/a/b/c");
    assert.equal(joinRoutePath("/api", "/"), "/api");
  });
});

describe("Route and EntryPoint helpers", () => {
  it("makes a Route like other languages and reads it back through list_routes", async () => {
    const handler = find("Function", "com.acme.UserController.get");
    const route = addJavaRoute(graph, { fileId: FILE, method: "GET", path: joinRoutePath("/api", "users/{id}"), framework: "spring-mvc", line: 14, handler });
    assert.deepEqual(route.properties, {
      method: "GET", path: "/api/users/{id}", fullPath: "/api/users/{id}", pathExpression: null, receiverName: null, line: 14, framework: "spring-mvc", handlerName: "get",
    });
    assert.ok(graph.relationships.some((rel) => rel.type === "DECLARES_ROUTE" && rel.from === FILE && rel.to === route.id));
    assert.ok(graph.relationships.some((rel) => rel.type === "ROUTE_HANDLED_BY" && rel.from === route.id && rel.to === handler.id));
    const twin = addJavaRoute(graph, { fileId: FILE, method: "GET", path: "/api/users/{id}", framework: "spring-mvc", line: 14, handler });
    assert.notEqual(twin.id, route.id);
    const dynamic = addJavaRoute(graph, { fileId: FILE, method: "ALL", path: null, pathExpression: "BASE", framework: "spring-mvc", line: 20, handlerName: "many" });
    assert.equal(dynamic.properties.pathExpression, "BASE");
    assert.equal(graph.relationships.some((rel) => rel.type === "ROUTE_HANDLED_BY" && rel.from === dynamic.id), false);

    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-annotations-store-"));
    const store = await openTestStore(path.join(dir, "graph"));
    try {
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const listed = (await callMcpTool(store, "list_routes", { framework: "spring-mvc" })).structuredContent as Record<string, any>;
      const rows = listed.routes.filter((row: any) => row.method === "GET");
      assert.equal(rows.length, 2);
      assert.deepEqual(
        { file: rows[0].file, line: rows[0].line, fullPath: rows[0].fullPath, handler: rows[0].handler, handlerName: rows[0].handlerName },
        { file: "src/main/java/com/acme/UserController.java", line: 14, fullPath: "/api/users/{id}", handler: "get", handlerName: "get" },
      );
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("makes an EntryPoint with the properties of the main entrypoint", () => {
    const handler = find("Function", "com.acme.UserController.mine");
    const entry = addJavaEntryPoint(graph, { fileId: FILE, kind: "main", line: 19, handler });
    assert.deepEqual(entry.properties, { kind: "main", trigger: null, receiverName: null, library: "java", line: 19, handlerName: "mine" });
    const grpc = addJavaEntryPoint(graph, { fileId: FILE, kind: "grpc", trigger: "Greeter/SayHello", library: "grpc", line: 19, handler });
    assert.equal(grpc.properties.trigger, "Greeter/SayHello");
    assert.notEqual(grpc.id, entry.id);
    assert.ok(graph.relationships.some((rel) => rel.type === "DECLARES_ENTRYPOINT" && rel.from === FILE && rel.to === grpc.id));
    assert.ok(graph.relationships.some((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === grpc.id && rel.to === handler.id));
  });
});

describe("one package-precision rule for unqualified annotations", () => {
  const SPRING = ["org.springframework.stereotype"];
  const MICRONAUT = ["io.micronaut.http.annotation"];
  const files: Record<string, string> = {
    // Wildcard from the requested package.
    "src/main/java/a/SpringWild.java": "package a;\nimport org.springframework.stereotype.*;\n@Controller\npublic class SpringWild {}\n",
    // Wildcard from another framework only.
    "src/main/java/a/MicronautWild.java": "package a;\nimport io.micronaut.http.annotation.*;\n@Controller\npublic class MicronautWild {}\n",
    // Wildcards from both: the requested one wins.
    "src/main/java/a/Both.java": "package a;\nimport io.micronaut.http.annotation.*;\nimport org.springframework.stereotype.*;\n@Controller\npublic class Both {}\n",
    // Nothing known: accepted as before.
    "src/main/java/a/Plain.java": "package a;\nimport java.util.*;\n@Controller\npublic class Plain {}\n",
    // The user's own type of that name in the same package, even beside a Spring wildcard.
    "src/main/java/own/Controller.java": "package own;\npublic @interface Controller {}\n",
    "src/main/java/own/Same.java": "package own;\nimport org.springframework.stereotype.*;\n@Controller\npublic class Same {}\n",
    // The user's own type from a scanned wildcard-imported package.
    "src/main/java/other/Wild.java": "package other;\nimport own.*;\n@Controller\npublic class Wild {}\n",
    // Partially qualified names: the first segment is a type, resolved through the single-type imports.
    "src/main/java/cli/Partial.java": "package cli;\nimport picocli.CommandLine;\n@CommandLine.Command(name = \"x\")\npublic class Partial {}\n",
    "src/main/java/cli/PartialUnknown.java": "package cli;\n@CommandLine.Command(name = \"x\")\npublic class PartialUnknown {}\n",
    "src/main/java/cli/PartialOther.java": "package cli;\nimport com.acme.CommandLine;\n@CommandLine.Command(name = \"x\")\npublic class PartialOther {}\n",
    // Nested types are not in scope for their package: `Order.Service` does not make `@Service` the user's own.
    "src/main/java/nest/Order.java": "package nest;\npublic class Order {\n  public @interface Service {}\n  @Service static class Inner {}\n}\n",
    "src/main/java/nest/Uses.java": "package nest;\nimport org.springframework.stereotype.Service;\n@Service\npublic class Uses {}\n",
    "src/main/java/nest/UsesPlain.java": "package nest;\n@Service\npublic class UsesPlain {}\n",
    "src/main/java/nest/NestWild.java": "package nest;\nimport nest.Order.*;\n@Service\npublic class NestWild {}\n",
  };
  let ruleGraph: GraphBuilder;
  let ruleRoot: string;
  before(async () => {
    ruleRoot = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-annotation-rule-"));
    for (const [file, source] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(ruleRoot, file)), { recursive: true });
      await writeFile(path.join(ruleRoot, file), source);
    }
    const result = await buildCodeGraph(ruleRoot, { continueOnError: false });
    ruleGraph = new GraphBuilder();
    ruleGraph.addNodes(result.nodes);
    ruleGraph.addRelationships(result.relationships);
  });
  after(async () => {
    await rm(ruleRoot, { recursive: true, force: true });
  });

  const annotationsOfClass = (name: string) => {
    const type = ruleGraph.nodes.find((node) => node.label === "Class" && node.properties.name === name);
    assert.ok(type, name);
    return javaAnnotationReader(ruleGraph).annotationsOf(type);
  };

  it("accepts a wildcard from a requested package, rejects one from another framework, accepts when nothing is known", () => {
    assert.equal(hasAnnotation(annotationsOfClass("SpringWild"), "Controller", SPRING), true);
    assert.equal(hasAnnotation(annotationsOfClass("SpringWild"), "Controller", MICRONAUT), false);
    assert.equal(hasAnnotation(annotationsOfClass("MicronautWild"), "Controller", SPRING), false);
    assert.equal(hasAnnotation(annotationsOfClass("MicronautWild"), "Controller", MICRONAUT), true);
    assert.equal(hasAnnotation(annotationsOfClass("Both"), "Controller", SPRING), true);
    assert.equal(hasAnnotation(annotationsOfClass("Both"), "Controller", MICRONAUT), true);
    assert.equal(hasAnnotation(annotationsOfClass("Plain"), "Controller", SPRING), true);
  });

  it("rejects an annotation the scan declares in the file's package or a wildcard-imported scanned package", () => {
    assert.equal(hasAnnotation(annotationsOfClass("Same"), "Controller", SPRING), false);
    assert.equal(hasAnnotation(annotationsOfClass("Wild"), "Controller", SPRING), false);
    assert.equal(hasAnnotation(annotationsOfClass("Wild"), "Controller"), true);
  });

  it("resolves a partially qualified name through the file's imports, never reading an upper-case segment as a package", () => {
    const partial = annotationsOfClass("Partial")[0]!;
    assert.equal(partial.qualifiedName, "picocli.CommandLine.Command");
    assert.equal(hasAnnotation(annotationsOfClass("Partial"), "Command", ["picocli"]), true);
    assert.equal(hasAnnotation(annotationsOfClass("Partial"), "Command", ["org.other"]), false);
    // Not imported: unknown, not a package-qualified name.
    assert.equal(annotationsOfClass("PartialUnknown")[0]!.qualifiedName, null);
    // Imported from somewhere else: that package, so not picocli.
    assert.equal(annotationsOfClass("PartialOther")[0]!.qualifiedName, "com.acme.CommandLine.Command");
    assert.equal(hasAnnotation(annotationsOfClass("PartialOther"), "Command", ["picocli"]), false);
  });

  it("counts only top-level types of the package as the user's own; a nested type only in its own file or by wildcard", () => {
    assert.equal(hasAnnotation(annotationsOfClass("Uses"), "Service", ["org.springframework.stereotype"]), true);
    assert.equal(hasAnnotation(annotationsOfClass("UsesPlain"), "Service", ["org.springframework.stereotype"]), true);
    // In the file of the outer type the nested `Service` is in scope.
    assert.equal(hasAnnotation(annotationsOfClass("Inner"), "Service", ["org.springframework.stereotype"]), false);
    // `import nest.Order.*;` brings it in.
    assert.equal(hasAnnotation(annotationsOfClass("NestWild"), "Service", ["org.springframework.stereotype"]), false);
  });
});

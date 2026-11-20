import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

// `GET /users -> UserHandler.list`, sorted by line within a file.
function routes(graph: Graph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.nodes
    .filter((node) => node.label === "Route" && node.properties.framework === "spring-webflux")
    .map((route) => {
      const file = graph.relationships.find((rel) => rel.type === "DECLARES_ROUTE" && rel.to === route.id)!.from.replace(/^(?:.*\/|file:)/u, "");
      const handler = graph.relationships.find((rel) => rel.type === "ROUTE_HANDLED_BY" && rel.from === route.id);
      const target = handler ? String(byId.get(handler.to)!.properties.qualifiedName).replace(/^com\.acme\.web\./u, "") : null;
      const where = route.properties.path ?? `<${String(route.properties.pathExpression)}>`;
      return `${file}:${String(route.properties.line).padStart(2, "0")} ${String(route.properties.method)} ${String(where)} -> ${target ?? `none(${String(route.properties.handlerName)})`}`;
    })
    .sort();
}

describe("Spring WebFlux functional routes (fixtures/java-webflux)", () => {
  let graph: Graph;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/java-webflux"), { continueOnError: false });
  });

  it("reads route/andRoute/andNest, the builder with path and nest, lambdas, or and unreadable predicates", () => {
    assert.deepEqual(routes(graph), [
      "FunctionalRoutes.java:21 GET /users -> UserHandler.list",
      "FunctionalRoutes.java:22 GET /users/{id} -> UserHandler.get",
      "FunctionalRoutes.java:23 POST /users -> UserHandler.create",
      "FunctionalRoutes.java:25 DELETE /admin/users/{id} -> UserHandler.remove",
      "FunctionalRoutes.java:31 GET /audit -> UserHandler.audit",
      "FunctionalRoutes.java:32 GET /health -> OrderHandler.health",
      "FunctionalRoutes.java:41 GET /api/orders -> OrderHandler.all",
      "FunctionalRoutes.java:42 GET /api/orders/{id} -> OrderHandler.one",
      "FunctionalRoutes.java:43 POST /api/orders -> OrderHandler.all",
      "FunctionalRoutes.java:44 PUT /orders/{id} -> OrderHandler.one",
      "FunctionalRoutes.java:52 GET /delegating -> UserHandler.list",
      "FunctionalRoutes.java:53 GET /inline -> none(null)",
      "FunctionalRoutes.java:60 GET <BASE + \"/items\"> -> UserHandler.list",
      "FunctionalRoutes.java:61 GET /a -> UserHandler.create",
      "FunctionalRoutes.java:61 POST /b -> UserHandler.create",
      "FunctionalRoutes.java:62 ALL <adminOnly()> -> UserHandler.remove",
      "StaticImportRoutes.java:19 GET /static/orders -> OrderHandler.all",
      "StaticImportRoutes.java:20 POST /static/orders -> OrderHandler.one",
    ]);
  });

  it("picks the ServerRequest overload and ignores files without the WebFlux package", () => {
    assert.ok(routes(graph).some((route) => route.includes("/audit -> UserHandler.audit")));
    const audit = graph.relationships.find((rel) => rel.type === "ROUTE_HANDLED_BY" && graph.nodes.find((node) => node.id === rel.from)?.properties.path === "/audit")!;
    assert.equal(JSON.parse(String(graph.nodes.find((node) => node.id === audit.to)!.properties.parameters))[0].type, "ServerRequest");
    assert.ok(routes(graph).every((route) => !route.startsWith("NotWebFlux")));
  });

  it("leaves no parse-time property behind", () => {
    assert.ok(graph.nodes.every((node) => !("javaWebfluxRoutes" in node.properties)));
  });
});

describe("Spring WebFlux functional routes: edge cases", () => {
  const scanSource = async (sources: Record<string, string>): Promise<Graph> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "webflux-"));
    try {
      for (const [name, source] of Object.entries(sources)) {
        await mkdir(path.dirname(path.join(root, name)), { recursive: true });
        await writeFile(path.join(root, name), source);
      }
      return await buildCodeGraph(root, { continueOnError: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };

  it("takes a method reference of a receiver typed by a parameter, a local and this", async () => {
    const graph = await scanSource({
      "A.java": `package p;
import org.springframework.web.reactive.function.server.*;
public class A {
  RouterFunction<ServerResponse> r(H param) {
    H local = new H();
    return RouterFunctions.route(RequestPredicates.GET("/p"), param::go)
      .andRoute(RequestPredicates.GET("/l"), local::go)
      .andRoute(RequestPredicates.GET("/t"), this::own)
      .andRoute(RequestPredicates.GET("/c"), H::stat)
      .andRoute(RequestPredicates.GET("/n"), missing::go);
  }
  ServerResponse own(ServerRequest q) { return null; }
}
class H {
  ServerResponse go(ServerRequest q) { return null; }
  static ServerResponse stat(ServerRequest q) { return null; }
}
`,
    });
    assert.deepEqual(routes(graph), [
      "A.java:06 GET /p -> p.H.go",
      "A.java:07 GET /l -> p.H.go",
      "A.java:08 GET /t -> p.A.own",
      "A.java:09 GET /c -> p.H.stat",
      "A.java:10 GET /n -> none(go)",
    ]);
  });

  it("makes a route with no resolvable path for a nest it cannot read and keeps a prefix constant as an expression", async () => {
    const graph = await scanSource({
      "B.java": `package p;
import org.springframework.web.reactive.function.server.*;
public class B {
  static final String ROOT = "/root";
  RouterFunction<ServerResponse> r() {
    return RouterFunctions.route().path(ROOT, b -> b.GET("/x", req -> null)).build();
  }
}
`,
    });
    const route = graph.nodes.find((node) => node.label === "Route")!;
    assert.equal(route.properties.path, null);
    assert.equal(route.properties.pathExpression, 'ROOT + "/x"');
    assert.equal(route.properties.method, "GET");
    assert.equal(route.properties.handlerName, null);
  });

  it("does not read methods that return something else, even in a WebFlux file", async () => {
    const graph = await scanSource({
      "C.java": `package p;
import org.springframework.web.reactive.function.server.*;
public class C {
  Object other() {
    return RouterFunctions.route(RequestPredicates.GET("/x"), req -> null);
  }
}
`,
    });
    assert.equal(graph.nodes.filter((node) => node.label === "Route").length, 0);
  });
});

describe("Spring WebFlux functional routes: the DSL only", () => {
  const scanSource = async (sources: Record<string, string>): Promise<Graph> => {
    const root = await mkdtemp(path.join(os.tmpdir(), "webflux-dsl-"));
    try {
      for (const [name, source] of Object.entries(sources)) await writeFile(path.join(root, name), source);
      return await buildCodeGraph(root, { continueOnError: false });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  const header = `package p;
import org.springframework.web.reactive.function.server.*;
import static org.springframework.web.reactive.function.server.RequestPredicates.*;
`;
  const strip = (rows: string[]): string[] => rows.map((row) => row.replace(/^[A-Z]\.java:\d+ /u, ""));

  it("ignores builder verbs on a receiver that is not a builder", async () => {
    const graph = await scanSource({
      "A.java": `${header}
public class A {
  interface Api { Api GET(String p, Object h); }
  RouterFunction<ServerResponse> r(Api api) {
    api.GET("/fake", null);
    return RouterFunctions.route().GET("/real", req -> null).nest(path("/n"), b -> b.POST("/p", req -> null)).build();
  }
}
`,
    });
    assert.deepEqual(strip(routes(graph)), ["GET /real -> none(null)", "POST /n/p -> none(null)"]);
  });

  it("does not read a user's own route(a, b) helper or an unimported static route", async () => {
    const graph = await scanSource({
      "A.java": `${header}
import static org.springframework.web.reactive.function.server.RouterFunctions.route;
public class A {
  RouterFunction<ServerResponse> own() { return route(GET("/own"), req -> null); }
  RouterFunction<ServerResponse> route(Object a, Object b) { return null; }
}
`,
      "B.java": `${header}
public class B {
  RouterFunction<ServerResponse> other() { return route(GET("/noimport"), req -> null); }
}
`,
    });
    assert.deepEqual(routes(graph), []);
  });

  it("emits no route for a nested route whose method conflicts with the enclosing predicate", async () => {
    const graph = await scanSource({
      "A.java": `${header}
import static org.springframework.web.reactive.function.server.RouterFunctions.*;
public class A {
  RouterFunction<ServerResponse> r() {
    return nest(GET("/a"), route(POST("/z"), req -> null)).andNest(GET("/b"), route(GET("/ok"), req -> null));
  }
}
`,
    });
    assert.deepEqual(strip(routes(graph)), ["GET /b/ok -> none(null)"]);
  });
});

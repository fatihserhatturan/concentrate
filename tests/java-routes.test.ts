import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

type Scanned = Awaited<ReturnType<typeof buildCodeGraph>>;

const summarize = (graph: Scanned): string[] =>
  graph.nodes
    .filter((node) => node.label === "Route")
    .map((route) => {
      const file = graph.relationships.find((rel) => rel.type === "DECLARES_ROUTE" && rel.to === route.id)!.from.slice("file:".length);
      const where = route.properties.path ?? `<${route.properties.pathExpression}>`;
      return `${route.properties.framework} ${route.properties.method} ${where} ${path.basename(file, ".java")}.${route.properties.handlerName}`;
    })
    .sort();

const scanFixture = (name: string) => buildCodeGraph(path.resolve("fixtures", name), { continueOnError: false });

async function scanSources(sources: Record<string, string>): Promise<Scanned> {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-routes-"));
  try {
    for (const [file, source] of Object.entries(sources)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), source);
    }
    return await buildCodeGraph(root, { continueOnError: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("Spring MVC routes (fixtures/java-spring-mvc)", () => {
  it("joins class and method paths, expands paths and methods, and inherits from interfaces", async () => {
    assert.deepEqual(summarize(await scanFixture("java-spring-mvc")), [
      "spring-mvc ALL /api/users/ping UserController.ping",
      "spring-mvc DELETE /api/users/{id} UserController.delete",
      "spring-mvc GET / PageController.home",
      "spring-mvc GET /about PageController.about",
      "spring-mvc GET /api/users UserController.list",
      "spring-mvc GET /api/users/search UserController.search",
      "spring-mvc GET /api/users/{id} UserController.get",
      // @RequestMapping("/orders") and the mappings come from the OrderApi interface.
      "spring-mvc GET /orders/{id} OrderController.find",
      // The unresolved constant is never guessed: no path, the expression instead.
      'spring-mvc GET <"/api/users" + Paths.BASE+"/dynamic"> UserController.dynamic',
      "spring-mvc POST /api/users UserController.create",
      "spring-mvc POST /api/users/bulk UserController.create",
      "spring-mvc POST /api/users/search UserController.search",
      "spring-mvc POST /orders OrderController.place",
      "spring-mvc PUT /api/users/{id} UserController.update",
    ]);
  });

  it("gives an unresolved path no path and keeps the expression", async () => {
    const graph = await scanFixture("java-spring-mvc");
    const route = graph.nodes.find((node) => node.label === "Route" && node.properties.handlerName === "dynamic")!;
    assert.equal(route.properties.path, null);
    assert.equal(route.properties.fullPath, null);
    assert.match(String(route.properties.pathExpression), /Paths\.BASE/);
  });

  it("ignores annotations of the same name from another package", async () => {
    const graph = await scanFixture("java-spring-mvc");
    assert.equal(summarize(graph).some((row) => row.includes("NotSpringController")), false);
  });
});

describe("JAX-RS routes (fixtures/java-jaxrs)", () => {
  it("joins @Path values, skips sub-resource locators and reads interface annotations", async () => {
    assert.deepEqual(summarize(await scanFixture("java-jaxrs")), [
      "jaxrs DELETE /users/{id} UserResource.delete",
      "jaxrs GET /health HealthResource.status",
      "jaxrs GET /health/live HealthResource.live",
      "jaxrs GET /users UserResource.list",
      "jaxrs GET /users/{id} UserResource.get",
      'jaxrs GET <Paths.ADMIN + "/stats"> AdminResource.stats',
      "jaxrs POST /users UserResource.create",
      "jaxrs PUT /users/{id} UserResource.update",
    ]);
  });
});

describe("Micronaut routes (fixtures/java-micronaut)", () => {
  it("reads value, uri and uris and defaults to the controller path", async () => {
    assert.deepEqual(summarize(await scanFixture("java-micronaut")), [
      "micronaut DELETE /users/{id} UserController.delete",
      "micronaut GET / RootController.home",
      "micronaut GET /status RootController.status",
      "micronaut GET /users UserController.list",
      "micronaut GET /users/a UserController.multi",
      "micronaut GET /users/b UserController.multi",
      "micronaut GET /users/by-name/{name} UserController.byName",
      "micronaut GET /users/{id} UserController.get",
      "micronaut PATCH /users/{id} UserController.patch",
      "micronaut POST /users UserController.create",
      "micronaut PUT /users/{id} UserController.update",
    ]);
  });
});

describe("Package precision", () => {
  it("does not take a Micronaut @Controller as Spring, nor the reverse", async () => {
    const graph = await scanSources({
      "src/main/java/a/Micro.java": `package a;

import io.micronaut.http.annotation.*;

@Controller("/m")
public class Micro {
  @Get("/x")
  public String x() { return ""; }
}
`,
      "src/main/java/a/Spring.java": `package a;

import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.*;

@Controller
@RequestMapping("/s")
public class Spring {
  @GetMapping("/y")
  @ResponseBody
  public String y() { return ""; }

  // Micronaut's @Get is not in the Spring imports: no route.
  @Get("/z")
  public String z() { return ""; }
}
`,
      "src/main/java/a/Other.java": `package a;

import org.example.Path;
import org.example.GET;

// Other packages' @Path and @GET are no JAX-RS.
@Path("/o")
public class Other {
  @GET
  public String o() { return ""; }
}
`,
    });
    assert.deepEqual(summarize(graph), ["micronaut GET /m/x Micro.x", "spring-mvc GET /s/y Spring.y"]);
  });

  it("uses javax and jakarta alike, and any method for a bare @RequestMapping", async () => {
    const graph = await scanSources({
      "src/main/java/a/Old.java": `package a;

import javax.ws.rs.GET;
import javax.ws.rs.OPTIONS;
import javax.ws.rs.Path;

@Path("old/")
public class Old {
  @GET
  @OPTIONS
  @Path("//a")
  public String a() { return ""; }
}
`,
      "src/main/java/a/Any.java": `package a;

import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public abstract class AbstractBase {
}
`,
      "src/main/java/a/Concrete.java": `package a;

import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
public class Concrete {
  @RequestMapping("/any")
  public String any() { return ""; }
}
`,
    });
    assert.deepEqual(summarize(graph), ["jaxrs GET /old/a Old.a", "jaxrs OPTIONS /old/a Old.a", "spring-mvc ALL /any Concrete.any"]);
  });
});

describe("list_routes", () => {
  it("lists the annotation routes with framework, file, line and handler", async () => {
    const { openTestStore } = await import("./helpers/store.js");
    const graph = await scanFixture("java-jaxrs");
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-routes-store-"));
    const store = await openTestStore(path.join(dir, "graph"));
    try {
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const listed = (await callMcpTool(store, "list_routes", { framework: "jaxrs" })).structuredContent as Record<string, any>;
      assert.equal(listed.routes.length, 8);
      const get = listed.routes.find((row: any) => row.handlerName === "get");
      assert.deepEqual(
        { file: get.file, line: get.line, method: get.method, fullPath: get.fullPath, framework: get.framework },
        { file: "src/main/java/com/acme/rest/UserResource.java", line: 15, method: "GET", fullPath: "/users/{id}", framework: "jaxrs" },
      );
      const dynamic = listed.routes.find((row: any) => row.handlerName === "stats");
      assert.equal(dynamic.fullPath ?? null, null);
    } finally {
      await store.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

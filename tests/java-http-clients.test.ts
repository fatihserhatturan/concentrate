import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { openTestStore } from "./helpers/store.js";

type Scanned = Awaited<ReturnType<typeof buildCodeGraph>>;

const scanFixture = (name: string, apiOrigins?: string[]) => buildCodeGraph(path.resolve("fixtures", name), { continueOnError: false, ...(apiOrigins ? { apiOrigins } : {}) });

async function scanSources(sources: Record<string, string>): Promise<Scanned> {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-http-"));
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

// `Class.line client METHOD url` of every Call that carries a request.
const calls = (graph: Scanned): string[] =>
  graph.nodes
    .filter((node) => node.label === "Call" && node.properties.httpClient !== undefined)
    .map((node) => `${/\/([A-Za-z]+)\.java/u.exec(node.id)![1]}:${node.properties.line} ${node.properties.httpClient} ${node.properties.httpMethod} ${node.properties.httpUrl}`)
    .sort();

const links = (graph: Scanned): string[] => {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "REQUESTS")
    .map((rel) => `${/\/([A-Za-z]+)\.java/u.exec(rel.from)![1]}:${byId.get(rel.from)!.properties.line} ${rel.properties.method} ${byId.get(rel.to)!.properties.fullPath}`)
    .sort();
};

describe("Java outbound HTTP (fixtures/java-http-clients)", () => {
  it("records each client's requests with base URLs from config and constants", async () => {
    assert.deepEqual(calls(await scanFixture("java-http-clients")), [
      "JdkClientGateway:14 httpclient GET /health",
      "JdkClientGateway:20 httpclient POST /api/users",
      "JdkClientGateway:29 httpclient PUT /api/users/${id}",
      "OkHttpGateway:13 okhttp DELETE /api/users/${id}",
      "OkHttpGateway:18 okhttp GET /api/users/${id}",
      "RestClientGateway:18 restclient GET /api/users/{id}",
      "RestClientGateway:22 restclient POST /api/users",
      "RestClientGateway:26 restclient DELETE /api/users/{id}",
      "RestClientGateway:30 restclient GET /health",
      "RestTemplateGateway:20 resttemplate GET /api/users/{id}",
      "RestTemplateGateway:24 resttemplate POST /api/users",
      "RestTemplateGateway:28 resttemplate PUT /api/users/${id}",
      "RestTemplateGateway:32 resttemplate DELETE /api/users/{id}",
      "RestTemplateGateway:36 resttemplate GET null",
      "WebClientGateway:13 webclient GET /api/users/search",
      "WebClientGateway:17 webclient PUT /api/users/{id}",
      "WebClientGateway:21 webclient GET /health",
      "WebClientGateway:25 webclient GET null",
    ]);
  });

  it("links the requests to the fixture's own routes; tests and look-alikes make none", async () => {
    const found = links(await scanFixture("java-http-clients"));
    assert.equal(found.length, 16);
    assert.ok(found.includes("RestTemplateGateway:20 GET /api/users/{id}"));
    assert.ok(found.includes("OkHttpGateway:13 DELETE /api/users/{id}"));
    assert.ok(found.includes("WebClientGateway:13 GET /api/users/search"));
    assert.ok(!found.some((entry) => entry.startsWith("LocalCache") || entry.startsWith("UserControllerTest")));
  });

  it("api_consumers answers for Java callers", async () => {
    const graph = await scanFixture("java-http-clients");
    const store = await openTestStore(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-java-http-store-")), "graph"));
    try {
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const result = (await callMcpTool(store, "api_consumers", { method: "GET", path: "/health" })).structuredContent as Record<string, any>;
      assert.deepEqual(result.consumers.map((row: any) => row.client).sort(), ["httpclient", "restclient", "webclient"]);
      assert.ok(result.consumers.every((row: any) => typeof row.function === "string"));
    } finally {
      await store.close();
    }
  });
});

describe("OpenFeign (fixtures/java-feign)", () => {
  it("records a request on each call of a Feign method", async () => {
    assert.deepEqual(calls(await scanFixture("java-feign")), [
      "InvoiceFacade:20 feign GET /api/invoices/{id}",
      "InvoiceFacade:22 feign POST /api/invoices",
      "InvoiceFacade:24 feign DELETE /api/invoices/{id}",
      "InvoiceFacade:26 feign GET /api/invoices/{id}/lines",
      "InvoiceFacade:28 feign GET http://inventory/stock/{sku}",
      "InvoiceFacade:30 feign GET /status",
    ]);
  });

  it("links the callers to the routes; a service name needs --api-origin", async () => {
    const found = links(await scanFixture("java-feign"));
    assert.equal(found.length, 5);
    assert.ok(found.includes("InvoiceFacade:30 GET /status"));
    const withOrigin = await scanFixture("java-feign", ["http://inventory"]);
    assert.ok(calls(withOrigin).includes("InvoiceFacade:28 feign GET /stock/{sku}"));
  });
});

const imports = `import org.springframework.web.client.RestTemplate;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.reactive.function.client.WebClient;
import org.springframework.context.annotation.Bean;
`;

describe("Java HTTP client reading", () => {
  it("ignores a user class named like a client, and test files", async () => {
    const graph = await scanSources({
      "src/main/java/a/RestTemplate.java": "package a;\npublic class RestTemplate { public String getForObject(String u, Class<String> c) { return u; } }\n",
      "src/main/java/a/Use.java": "package a;\nclass Use { RestTemplate rest = new RestTemplate(); String run() { return rest.getForObject(\"/x\", String.class); } }\n",
      "src/test/java/a/UseTest.java": "package a;\nimport org.springframework.web.client.RestTemplate;\nclass UseTest { RestTemplate rest; void t() { rest.getForObject(\"/y\", String.class); } }\n",
    });
    assert.deepEqual(calls(graph), []);
  });

  it("keeps a dynamic start unlinked, drops the query and reads @Value fields", async () => {
    const graph = await scanSources({
      "src/main/resources/application.properties": "api.base-url=http://localhost:9000/v1\n",
      "src/main/java/a/Svc.java": `package a;\n${imports}class Svc {
  @Value("\${api.base-url}") String baseUrl;
  @Value("\${api.other}") String other;
  RestTemplate rest;
  void run(String dynamic, long id) {
    rest.getForObject(dynamic + "/x", String.class);
    rest.getForObject(baseUrl + "/items/{id}?full=true", String.class, id);
    rest.getForObject(other + "/items", String.class);
  }
}\n`,
    });
    assert.deepEqual(calls(graph), [
      "Svc:11 resttemplate GET ${dynamic}/x",
      "Svc:12 resttemplate GET /v1/items/{id}",
      "Svc:13 resttemplate GET ${env:API_OTHER}/items",
    ]);
  });

  it("takes the base of the one @Bean client for an injected WebClient", async () => {
    const graph = await scanSources({
      "src/main/java/a/Config.java": `package a;\n${imports}class Config { @Bean WebClient web() { return WebClient.builder().baseUrl("http://localhost:1/api").build(); } }\n`,
      "src/main/java/a/Svc.java": `package a;\n${imports}class Svc {
  private final WebClient web;
  Svc(WebClient web) { this.web = web; }
  void run() { web.get().uri("/ping").retrieve(); }
}\n`,
    });
    assert.deepEqual(calls(graph), ["Svc:9 webclient GET /api/ping"]);
  });

  it("leaves no private property behind", async () => {
    const graph = await scanFixture("java-feign");
    assert.ok(!graph.nodes.some((node) => node.properties.javaHttp !== undefined || node.properties.javaHttpBean !== undefined));
  });
});

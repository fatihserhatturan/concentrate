import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { parsePlaceholders, redactValue, isSecretKey, springConfigProfile } from "../src/integrations/frameworks/java/config-files.js";

type Scanned = Awaited<ReturnType<typeof buildCodeGraph>>;

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

const calls = (graph: Scanned): string[] =>
  graph.nodes
    .filter((node) => node.label === "Call" && node.properties.httpClient !== undefined)
    .map((node) => `${/\/([A-Za-z]+)\.java/u.exec(node.id)![1]}:${node.properties.line} ${node.properties.httpClient} ${node.properties.httpMethod} ${node.properties.httpUrl}`)
    .sort();

const IMPORTS = "import org.springframework.web.client.RestTemplate;\nimport org.springframework.beans.factory.annotation.Value;\nimport org.springframework.web.util.UriComponentsBuilder;\n";

describe("Java HTTP and config: review fixes (F2)", () => {
  it("parses unclosed placeholders in linear time", () => {
    const started = Date.now();
    for (let i = 0; i < 40; i += 1) parsePlaceholders("${".repeat(40));
    assert.ok(Date.now() - started < 100, `took ${Date.now() - started}ms`);
    assert.deepEqual(parsePlaceholders("${a:${b}}x"), [{ key: [{ text: "a" }], default: [{ key: [{ text: "b" }], default: null }] }, { text: "x" }]);
  });

  it("knows secret keys by segment and redacts values", () => {
    for (const key of ["db.password", "a.private-key", "x.apiKey", "x.signing_key", "client.secret", "some.tokens"]) assert.ok(isSecretKey(key), key);
    for (const key of ["cache.key-prefix", "a.key", "monkey.name"]) assert.ok(!isSecretKey(key), key);
    assert.equal(redactValue("a.b", "amqp://u:pw@h:5672"), "amqp://u:<redacted>@h:5672");
    assert.equal(redactValue("db.passage", "v"), "v");
  });

  it("accepts config/ directories at a root, not inside a source tree", () => {
    assert.equal(springConfigProfile("config/application.properties"), null);
    assert.equal(springConfigProfile("svc/config/application-dev.yml"), "dev");
    assert.equal(springConfigProfile("config/eu/application.yml"), null);
    assert.equal(springConfigProfile("src/main/java/config/application.yml"), undefined);
  });

  it("never resolves a secret key into a URL and strips userinfo", async () => {
    const graph = await scanSources({
      "src/main/resources/application.properties": "svc.token=abc\nsvc.url=http://real:8080/\nsvc.auth-url=http://u:pw@auth/\n",
      "src/main/java/a/Svc.java": `package a;\n${IMPORTS}class Svc {
  @Value("\${svc.token}") String token;
  @Value("\${svc.auth-url}") String auth;
  RestTemplate rest;
  void run() {
    rest.getForObject("http://h/x?t=" + token, String.class);
    rest.getForObject(auth + "p", String.class);
    rest.getForObject("http://me:pw@h/y", String.class);
    rest.getForObject("http://h/\${svc.token}", String.class);
  }
}\n`,
    });
    const found = calls(graph);
    assert.ok(found.includes("Svc:11 resttemplate GET http://auth/p"), found.join("\n"));
    assert.ok(found.includes("Svc:12 resttemplate GET http://h/y"), found.join("\n"));
    assert.ok(!found.some((row) => row.includes("abc") || row.includes("pw")), found.join("\n"));
  });

  it("honours spring.profiles.active for placeholders", async () => {
    const graph = await scanSources({
      "src/main/resources/application.properties": "api.url=http://base\nspring.profiles.active=dev\n",
      "src/main/resources/application-dev.properties": "api.url=http://dev\n",
      "src/main/java/a/Svc.java": `package a;\n${IMPORTS}class Svc {
  @Value("\${api.url}") String url;
  RestTemplate rest;
  void run() { rest.getForObject(url + "/x", String.class); }
}\n`,
    });
    assert.deepEqual(calls(graph), ["Svc:8 resttemplate GET http://dev/x"]);
  });

  it("matches a subclass of RestTemplate but not a look-alike", async () => {
    const graph = await scanSources({
      "src/main/java/a/My.java": `package a;\n${IMPORTS}class My extends RestTemplate {}\n`,
      "src/main/java/a/Use.java": `package a;\nclass Use { My my = new My(); void run() { my.getForObject("/sub", String.class); } }\n`,
      "src/main/java/b/RestTemplate.java": "package b;\npublic class RestTemplate { public String getForObject(String u, Class<String> c) { return u; } }\n",
      "src/main/java/b/Fake.java": "package b;\nclass Fake extends RestTemplate { void run() { getForObject(\"/f\", String.class); } }\nclass User { Fake f = new Fake(); void run() { f.getForObject(\"/fake\", String.class); } }\n",
    });
    assert.deepEqual(calls(graph), ["Use:2 resttemplate GET /sub"]);
  });

  it("joins UriComponentsBuilder.path with single slashes", async () => {
    const graph = await scanSources({
      "src/main/java/a/U.java": `package a;\n${IMPORTS}class U {
  RestTemplate rest;
  void a() { rest.getForObject(UriComponentsBuilder.fromHttpUrl("http://h/").path("/z").toUriString(), String.class); }
  void b() { rest.getForObject(UriComponentsBuilder.fromHttpUrl("http://h").path("z").path("/y/").toUriString(), String.class); }
  void c() { rest.getForObject(UriComponentsBuilder.fromHttpUrl("http://h/").pathSegment("p", "q").toUriString(), String.class); }
}\n`,
    });
    assert.deepEqual(calls(graph), ["U:7 resttemplate GET http://h/z", "U:8 resttemplate GET http://h/z/y/", "U:9 resttemplate GET http://h/p/q"]);
  });

  it("links a Feign overload only when the argument count picks one", async () => {
    const graph = await scanSources({
      "src/main/java/a/F.java": `package a;
import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;
@FeignClient(name = "users", url = "http://users")
public interface F {
  @PostMapping(path = "/u") String make(String a);
  @PostMapping(path = "/u2") String make(String a, String b);
  @PostMapping(path = "/u3") String make(int a, int b);
}\n`,
      "src/main/java/a/U.java": "package a;\nclass U { F f; void a() { f.make(\"a\"); f.make(\"a\", \"b\"); f.make(1, 2); } }\n",
    });
    assert.deepEqual(calls(graph), ["U:2 feign POST http://users/u"]);
  });

  it("leaves no @Bean fact behind when there is nothing to link", async () => {
    const graph = await scanSources({
      "src/main/java/a/Cfg.java": "package a;\nimport org.springframework.context.annotation.Bean;\nimport org.springframework.web.reactive.function.client.WebClient;\npublic class Cfg { @Bean WebClient wc() { return WebClient.create(\"http://b\"); } }\n",
    });
    assert.ok(!graph.nodes.some((node) => node.properties.javaHttpBean !== undefined));
  });
});

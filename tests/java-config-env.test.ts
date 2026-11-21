import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import type { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { openTestStore } from "./helpers/store.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const shortFile = (id: string) => id.replace(/^file:src\/main\/(?:java\/com\/acme|resources)\//u, "");

// "<reader> <ENV> <line> <access>" of USES_ENV, from functions (`fn:` + name), routes and files.
function envReads(graph: Graph, kind: "Function" | "File" | "Route"): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "USES_ENV" && byId.get(rel.from)?.label === kind)
    .map((rel) => {
      const from = byId.get(rel.from)!;
      const reader = kind === "Function" ? String(from.properties.name) : kind === "Route" ? `${from.properties.method} ${from.properties.fullPath}` : shortFile(from.id);
      return `${reader} ${String(byId.get(rel.to)?.properties.name)} ${String(rel.properties.line)} ${String(rel.properties.access)}`;
    })
    .sort();
}

// "<reader> -> <key>@<file of the node>" of CONSUMES_CONFIG.
function consumes(graph: Graph, kind: "Function" | "File" | "Route"): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "CONSUMES_CONFIG" && byId.get(rel.from)?.label === kind)
    .map((rel) => {
      const from = byId.get(rel.from)!;
      const reader = kind === "Function" ? String(from.properties.name) : kind === "Route" ? `${from.properties.method} ${from.properties.fullPath}` : shortFile(from.id);
      const to = byId.get(rel.to)!;
      return `${reader} -> ${String(to.properties.name)}@${shortFile(rel.to).split(":config")[0]} (${String(rel.properties.localName)})`;
    })
    .sort();
}

describe("Java config and env: java-spring-config fixture", () => {
  let graph: Graph;
  let store: GraphStore;
  const tool = async (name: string, args: Record<string, unknown>) => (await callMcpTool(store, name, args)).structuredContent as Record<string, any>;

  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/java-spring-config"), { continueOnError: false });
    store = await openTestStore(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-java-env-")), "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
  });

  it("reads System.getenv in its forms, with constant keys, and leaves System.getProperty and look-alikes", () => {
    assert.deepEqual(envReads(graph, "Function").filter((row) => !row.includes("@Value") && !row.includes("Environment") && !row.includes("relaxed")), [
      "password DB_PASSWORD 17 System.getenv",
      "prefixed APP_TOKEN 19 System.getenv",
      "region REGION 18 System.getenv",
      "status RELEASE 24 System.getenv",
      "viaImport HOME_DIR 25 System.getenv",
      "viaLocal TZ 23 System.getenv().get",
      "viaMap LOG_LEVEL 20 System.getenv().get",
    ]);
    // A field initializer belongs to the file.
    assert.ok(envReads(graph, "File").includes("config/EnvUsage.java APP_MODE 11 System.getenv"));
    const names = new Set(graph.nodes.filter((node) => node.label === "EnvVar").map((node) => node.properties.name));
    for (const absent of ["NOT_ENV", "user.dir", "app.mail.host"]) assert.equal(names.has(absent), false, absent);
    // The `.env` file's variables and the routes' reads come from the JS/TS env contributors.
    assert.deepEqual(envReads(graph, "Route"), ["GET /status RELEASE 24 System.getenv"]);
  });

  it("makes a ConfigValue of every key of every config file, one per file", () => {
    const values = graph.nodes.filter((node) => node.label === "ConfigValue").map((node) => `${shortFile(node.id).split(":config")[0]} ${String(node.properties.line)} ${String(node.properties.name)}=${String(node.properties.value)} (${String(node.properties.valueType)})`).sort();
    assert.ok(values.includes("application.yml 6 app.mail.port=25 (number)"));
    assert.ok(values.includes("application.yml 9 app.mail.retry.max-attempts=3 (number)"));
    assert.ok(values.includes("application.yml 11 app.mail.allowed-senders[0]=a@example.com (string)"));
    assert.ok(values.includes("application.yml 17 server.port=${PORT:8080} (string)"));
    // A profile file has its own node for a key the default file has.
    assert.ok(values.includes("application.yml 5 app.mail.host=smtp.example.com (string)"));
    assert.ok(values.includes("application-prod.properties 2 app.mail.host=smtp.prod.example.com (string)"));
    assert.ok(values.includes("application-prod.properties 3 app.feature.enabled=true (boolean)"));
    // A default of an `@Value` no file defines.
    assert.ok(values.includes("config/AppSettings.java 15 app.greeting=hello (default)"));
    const declared = graph.relationships.filter((rel) => rel.type === "DECLARES_CONFIG" && rel.from.startsWith("file:src/main/resources/application.yml"));
    assert.equal(declared.length, 14);
  });

  it("reads ${ENV} placeholders of config files as USES_ENV", () => {
    assert.deepEqual(envReads(graph, "File").filter((row) => row.includes("config placeholder")), [
      "application-prod.properties DB_PASSWORD 4 config placeholder",
      "application.yml DB_HOST 20 config placeholder",
      "application.yml DB_PASSWORD 22 config placeholder",
      "application.yml PORT 17 config placeholder",
    ]);
  });

  it("links @Value on fields, parameters and setters to the keys, the reading methods and the file", () => {
    const functions = consumes(graph, "Function");
    // A field: the methods that read it (`name`, `this.timeout`), not the one with a parameter of the same name.
    assert.ok(functions.includes("label -> app.name@application.yml (name)"));
    assert.ok(functions.includes("limit -> app.timeout@application.yml (timeout)"));
    assert.ok(functions.includes("label -> app.greeting@config/AppSettings.java (greeting)"));
    assert.ok(!functions.some((row) => row.startsWith("unrelated ")));
    // Parameters of a constructor, a @Bean method and a controller method; a setter.
    assert.ok(functions.includes("AppSettings -> spring.datasource.url@application.yml (url)"));
    assert.ok(functions.includes("dataSourceUrl -> spring.datasource.url@application.yml (url)"));
    assert.ok(functions.includes("dataSourceUrl -> spring.datasource.username@application.yml (user)"));
    assert.ok(functions.includes("sender -> app.mail.from-address@application.yml (from)"));
    assert.ok(functions.includes("setFrom -> app.mail.from-address@application.yml (setFrom)"));
    assert.deepEqual(consumes(graph, "Route").filter((row) => row.includes("sender") || row.includes("/sender")), ["GET /sender -> app.mail.from-address@application.yml (from)"]);
    // Literals, SpEL and another package's `Value` read nothing.
    const files = consumes(graph, "File");
    assert.ok(!files.some((row) => row.startsWith("lombok/")));
    assert.ok(!files.some((row) => row.includes("(literal)") || row.includes("user.name")));
    // An environment variable that is no key.
    assert.ok(envReads(graph, "Function").includes("where REGION 19 @Value"));
  });

  it("binds @ConfigurationProperties classes, nested classes, records and @Bean methods to the keys under the prefix", () => {
    const files = consumes(graph, "File");
    for (const row of [
      "config/MailProperties.java -> app.mail.host@application-prod.properties (host)",
      "config/MailProperties.java -> app.mail.host@application.yml (host)",
      "config/MailProperties.java -> app.mail.from-address@application.yml (fromAddress)",
      "config/MailProperties.java -> app.mail.allowed-senders[1]@application.yml (allowedSenders)",
      "config/MailProperties.java -> app.mail.retry.max-attempts@application.yml (retry.maxAttempts)",
      "config/ClientProperties.java -> app.client.base-url@application.yml (baseUrl)",
      "config/ClientProperties.java -> app.client.connect-timeout@application.yml (connectTimeout)",
    ]) assert.ok(files.includes(row), row);
    // A @Bean method's returned class: the method binds.
    assert.ok(consumes(graph, "Function").includes("featureProperties -> app.feature.enabled@application-prod.properties (enabled)"));
    // Readers: accessor calls on a value of the class (a field), nested ones by their top-level field.
    const functions = consumes(graph, "Function");
    assert.ok(functions.includes("status -> app.mail.host@application.yml (host)"));
    assert.ok(functions.includes("status -> app.mail.host@application-prod.properties (host)"));
    assert.ok(functions.includes("client -> app.client.base-url@application.yml (baseUrl)"));
    assert.ok(functions.includes("retries -> app.mail.retry.max-attempts@application.yml (retry.maxAttempts)"));
    // The constructor storing the properties reads nothing; `getHost` does not read the port.
    assert.ok(!functions.some((row) => row.startsWith("StatusController ")));
    assert.ok(!functions.includes("status -> app.mail.port@application.yml (port)"));
    assert.ok(consumes(graph, "Route").includes("GET /client -> app.client.base-url@application.yml (baseUrl)"));
  });

  it("reads Environment.getProperty through the receiver type and a relaxed-binding env override", () => {
    const functions = consumes(graph, "Function");
    assert.ok(functions.includes("host -> app.mail.host@application.yml (app.mail.host)"));
    assert.ok(functions.includes("enabled -> app.feature.enabled@application-prod.properties (app.feature.enabled)"));
    assert.ok(functions.includes("port -> app.mail.port@application.yml (app.mail.port)"));
    // `Properties.getProperty` is not the environment.
    assert.ok(!functions.some((row) => row.startsWith("fromProperties ")));
    const envs = envReads(graph, "Function");
    assert.ok(envs.includes("viaEnvVar SPRING_DEMO_TOKEN 39 Environment.getProperty"));
    // APP_MAIL_PORT is declared in `.env.example`: it overrides app.mail.port.
    assert.ok(envs.includes("port APP_MAIL_PORT 38 spring relaxed binding"));
    // No other variable is made up: APP_MAIL_HOST is mentioned nowhere.
    assert.ok(!graph.nodes.some((node) => node.label === "EnvVar" && node.properties.name === "APP_MAIL_HOST"));
  });

  it("answers list_env_config for Java env reads, config keys and unread variables", async () => {
    const release = await tool("list_env_config", { name: "RELEASE" });
    assert.deepEqual(release.envConfig.map((row: any) => [row.kind, row.file, row.line, row.value]), [["env", "src/main/java/com/acme/web/StatusController.java", 24, "System.getenv"]]);
    const password = await tool("list_env_config", { name: "DB_PASSWORD" });
    assert.deepEqual(password.envConfig.filter((row: any) => row.kind === "env").map((row: any) => [row.file, row.line, row.value]), [
      ["src/main/java/com/acme/config/EnvUsage.java", 17, "System.getenv"],
      ["src/main/resources/application-prod.properties", 4, "config placeholder"],
      ["src/main/resources/application.yml", 22, "config placeholder"],
    ]);
    const host = await tool("list_env_config", { name: "app.mail.host" });
    const configs = host.envConfig.filter((row: any) => row.kind === "config").map((row: any) => [row.file, row.line, row.value]);
    assert.deepEqual(configs, [
      ["src/main/resources/application-prod.properties", 2, "smtp.prod.example.com"],
      ["src/main/resources/application.yml", 5, "smtp.example.com"],
    ]);
    const consumers = host.envConfig.filter((row: any) => row.kind === "config-consumer").map((row: any) => row.file).sort();
    assert.ok(consumers.includes("src/main/java/com/acme/config/MailProperties.java"));
    assert.ok(consumers.includes("src/main/java/com/acme/config/EnvUsage.java"));
    const unread = await tool("list_env_config", { unread: true });
    const kinds = new Map(unread.envConfig.map((row: any) => [row.name, row.kind]));
    assert.equal(kinds.get("UNUSED_FLAG"), "unread");
    assert.equal(kinds.has("DB_PASSWORD"), false);
    assert.equal(kinds.has("APP_MAIL_PORT"), false);
  });

  it("describes what a handler reads: impact_of lists its env variables", async () => {
    const impact = await tool("impact_of", { symbol: "status" });
    assert.ok(impact.envVars.some((row: any) => row.name === "RELEASE"));
    assert.ok(impact.config.some((row: any) => row.name === "app.mail.host"));
  });
});

describe("Java config and env: rules", () => {
  const dirs: string[] = [];
  after(async () => {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  });

  async function scan(files: Record<string, string>): Promise<Graph> {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-config-"));
    dirs.push(dir);
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    return buildCodeGraph(dir, { continueOnError: false });
  }
  const reads = (graph: Graph) => envReads(graph, "Function");

  it("takes System.getenv with a static import, a java.lang.System prefix and a constant key; skips dynamic keys", async () => {
    const graph = await scan({
      "src/main/java/a/Keys.java": "package a;\npublic class Keys { public static final String HOME = \"HOME_DIR\"; }\n",
      "src/main/java/a/Env.java": `package a;
import static java.lang.System.getenv;
public class Env {
  String a() { return getenv("A_VAR"); }
  String b() { return java.lang.System.getenv(Keys.HOME); }
  String c(String n) { return System.getenv(n); }
  String d() { return other.getenv("NOT_SYSTEM"); }
  String e() { return System.getProperty("e"); }
  String f() { var env = System.getenv(); return env.get("F_VAR"); }
}
`,
    });
    assert.deepEqual(reads(graph), ["a A_VAR 4 System.getenv", "b HOME_DIR 5 System.getenv", "f F_VAR 9 System.getenv().get"]);
  });

  it("reads an unqualified getenv only when System.getenv is statically imported", async () => {
    const graph = await scan({ "src/main/java/a/Env.java": "package a;\npublic class Env { String getenv(String k) { return k; } String a() { return getenv(\"NOT_ENV\"); } }\n" });
    assert.deepEqual(reads(graph), []);
  });

  it("ignores an @Value of another package, SpEL and plain literals, and takes Micronaut's @Value and @Property", async () => {
    const graph = await scan({
      "src/main/resources/application.yml": "app:\n  name: demo\n  port: 1\n",
      "src/main/java/a/Lombok.java": "package a;\nimport lombok.Value;\n@Value public class Lombok { String name; }\n",
      "src/main/java/a/Field.java": "package a;\nimport lombok.Value;\npublic class Field { @Value(\"${app.name}\") String name; String n() { return name; } }\n",
      "src/main/java/a/Spel.java": "package a;\nimport org.springframework.beans.factory.annotation.Value;\npublic class Spel { @Value(\"#{${app.name}}\") String a; @Value(\"app.name\") String b; String n() { return a + b; } }\n",
      "src/main/java/a/Mn.java": "package a;\nimport io.micronaut.context.annotation.Property;\nimport io.micronaut.context.annotation.Value;\npublic class Mn { String n(@Value(\"${app.name}\") String a, @Property(name = \"app.port\") int p) { return a; } }\n",
    });
    assert.deepEqual(consumes(graph, "Function").map((row) => row.replace(/\.java.*$/u, "")), ["n -> app.name@application.yml (a)", "n -> app.port@application.yml (p)"]);
    assert.deepEqual(consumes(graph, "File").filter((row) => row.includes("/a/")), [
      "file:src/main/java/a/Mn.java -> app.name@application.yml (a)",
      "file:src/main/java/a/Mn.java -> app.port@application.yml (p)",
    ]);
  });

  it("binds a Micronaut @ConfigurationProperties and relaxed field names, and a prefix with a trailing dot", async () => {
    const graph = await scan({
      "src/main/resources/application.properties": "my-app.api_url=u\nMY-APP.retryCount=3\nmyapp.other=x\n",
      "src/main/java/a/Props.java": "package a;\nimport io.micronaut.context.annotation.ConfigurationProperties;\n@ConfigurationProperties(\"my-app.\")\npublic class Props { String apiUrl; int retryCount; }\n",
    });
    const rows = consumes(graph, "File").map((row) => row.replace(/^.*Props\.java/u, "Props.java"));
    assert.deepEqual(rows, ["Props.java -> MY-APP.retryCount@application.properties (retryCount)", "Props.java -> my-app.api_url@application.properties (apiUrl)"]);
  });

  it("does not take a class with another package's @ConfigurationProperties, and a prefix-less annotation", async () => {
    const graph = await scan({
      "src/main/resources/application.properties": "app.x=1\n",
      "src/main/java/a/Other.java": "package a;\nimport com.other.ConfigurationProperties;\n@ConfigurationProperties(prefix = \"app\")\npublic class Other { int x; }\n",
      "src/main/java/a/NoPrefix.java": "package a;\nimport org.springframework.boot.context.properties.ConfigurationProperties;\n@ConfigurationProperties\npublic class NoPrefix { int x; }\n",
    });
    assert.deepEqual(consumes(graph, "File"), []);
  });

  it("redacts the value of a secret key but keeps a placeholder", async () => {
    const graph = await scan({
      "src/main/resources/application.properties": "db.password=hunter2\ndb.token=${TOKEN}\napp.secret-name=plain\ndb.user=me\n",
      "src/main/java/a/Plain.java": "package a;\npublic class Plain { }\n",
    });
    const value = (name: string) => graph.nodes.find((node) => node.label === "ConfigValue" && node.properties.name === name)?.properties.value;
    assert.equal(value("db.password"), "<redacted>");
    assert.equal(value("db.token"), "${TOKEN}");
    assert.equal(value("app.secret-name"), "<redacted>");
    assert.equal(value("db.user"), "me");
  });

  it("makes nothing without Java code or config files", async () => {
    const graph = await scan({ "src/main/java/a/Plain.java": "package a;\npublic class Plain { int x() { return 1; } }\n" });
    assert.equal(graph.nodes.filter((node) => node.label === "ConfigValue" || node.label === "EnvVar").length, 0);
    assert.ok(graph.nodes.every((node) => !("javaConfigEnv" in node.properties)));
  });

  it("keeps the key of an unresolved lower-case placeholder out of the environment", async () => {
    const graph = await scan({
      "src/main/java/a/Svc.java": "package a;\nimport org.springframework.beans.factory.annotation.Value;\npublic class Svc { void m(@Value(\"${some.key}\") String a, @Value(\"${OTHER:x}\") String b) {} }\n",
    });
    assert.deepEqual(reads(graph), ["m OTHER 3 @Value"]);
    assert.deepEqual(consumes(graph, "Function"), ['m -> OTHER@file:src/main/java/a/Svc.java (b)']);
  });
});

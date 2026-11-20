import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { openTestStore } from "./helpers/store.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

function injections(graph: Graph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "INJECTS")
    .map((rel) => `${byId.get(rel.from)!.properties.name} -> ${byId.get(rel.to)!.properties.name} ${rel.properties.fieldName} ${rel.properties.via}${rel.properties.beanMethod ? ` @Bean:${rel.properties.beanMethod}` : ""}`)
    .sort();
}

async function scanSources(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-di-"));
  try {
    await mkdir(path.join(dir, "src/main/java/app"), { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, "src/main/java/app", name), text);
    return await buildCodeGraph(dir, { continueOnError: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("Java dependency injection (fixtures/java-spring-di)", () => {
  it("links constructor, field, setter and @Bean parameter injection", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/java-spring-di"), { continueOnError: false });
    assert.deepEqual(injections(graph), [
      "AppConfig -> AuditLog log bean-parameter",
      "ClockUser -> SystemClock systemClock field",
      "Controller -> EmailNotifier notifier constructor",
      "Controller -> OrderService orders constructor",
      "Mailer -> SmsNotifier notifier bean-parameter",
      "OrderService -> AppConfig cache field @Bean:cache",
      "OrderService -> AuditLog auditLog field",
      "OrderService -> EmailNotifier allNotifiers field",
      "OrderService -> EmailNotifier notifier field",
      "OrderService -> Mailer mailer setter @Bean:mailer",
      "OrderService -> SmsNotifier allNotifiers field",
      "OrderService -> SmsNotifier smsNotifier field",
      "OrderService -> UserService users setter",
      "UserService -> AuditLog audit constructor",
      "UserService -> JpaUserRepository repository constructor",
    ]);
  });

  it("marks providers and counts the ambiguous injection", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/java-spring-di"), { continueOnError: false });
    const classes = graph.nodes.filter((node) => node.label === "Class");
    const roles = classes.filter((node) => node.properties.diStereotype).map((node) => `${node.properties.name}:${node.properties.diStereotype}:${node.properties.diBeanName}`).sort();
    assert.deepEqual(roles, [
      "AppConfig:Configuration:appConfig",
      "AuditLog:Service:auditLog",
      "ClockUser:Component:clockUser",
      "Controller:RestController:controller",
      "EmailNotifier:Component:emailNotifier",
      "FixedClock:Singleton:fixedClock",
      "JpaUserRepository:Repository:jpaUserRepository",
      "OrderService:Service:orderService",
      "SmsNotifier:Component:sms",
      "SystemClock:Named:systemClock",
      "UserService:Service:userService",
    ]);
    const ambiguous = classes.filter((node) => node.properties.ambiguousInjections).map((node) => `${node.properties.name}:${node.properties.ambiguousInjections}`);
    assert.deepEqual(ambiguous, ["ClockUser:1"]);
    const beans = graph.nodes.filter((node) => node.label === "Function" && node.properties.diBean).map((node) => `${node.properties.name}:${node.properties.diBean}`).sort();
    assert.deepEqual(beans, ["cache:sessionCache", "mailer:mailer"]);
  });

  it("answers find_references for a Java service through INJECTS", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/java-spring-di"), { continueOnError: false });
    const store = await openTestStore(path.join(await mkdtemp(path.join(os.tmpdir(), "concentrate-java-di-store-")), "graph"));
    try {
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const result = (await callMcpTool(store, "find_references", { symbol: "UserService" })).structuredContent as { references?: Array<{ kind: string; from?: string; detail?: string }> };
      const injected = JSON.stringify(result);
      assert.match(injected, /OrderService/u);
      assert.match(injected, /users/u);
      assert.doesNotMatch(injected, /Controller/u);
    } finally {
      await store.close();
    }
  });
});

describe("Java dependency injection resolution rules", () => {
  it("resolves by @Primary, @Qualifier, @Named and the name of the point, and counts what stays ambiguous", async () => {
    const graph = await scanSources({
      "Repo.java": "package app;\ninterface Repo {}\n",
      "A.java": "package app;\nimport org.springframework.stereotype.Repository;\n@Repository class A implements Repo {}\n",
      "B.java": "package app;\nimport org.springframework.stereotype.Repository;\n@Repository(\"bee\") class B implements Repo {}\n",
      "C.java": "package app;\nimport org.springframework.stereotype.Service;\nimport org.springframework.beans.factory.annotation.Autowired;\nimport org.springframework.beans.factory.annotation.Qualifier;\nimport jakarta.inject.Named;\n"
        + "@Service class C {\n  @Autowired @Qualifier(\"bee\") Repo one;\n  @Autowired @Named(\"a\") Repo two;\n  @Autowired Repo a;\n  @Autowired Repo nothing;\n  @Autowired @Qualifier(\"missing\") Repo gone;\n  @Autowired @Qualifier(NAMES.X) Repo dynamic;\n}\n",
    });
    assert.deepEqual(injections(graph), ["C -> A a field", "C -> A two field", "C -> B one field"]);
    // `nothing` (no tie breaker) and `dynamic` (unresolvable qualifier) are counted; `gone` names no bean: no edge.
    const consumer = graph.nodes.find((node) => node.label === "Class" && node.properties.name === "C")!;
    assert.equal(consumer.properties.ambiguousInjections, 2);
  });

  it("injects a type that is not a bean, or not scanned, nowhere and never counts it", async () => {
    const graph = await scanSources({
      "Plain.java": "package app;\nclass Plain {}\n",
      "S.java": "package app;\nimport org.springframework.stereotype.Service;\nimport org.springframework.beans.factory.annotation.Autowired;\n@Service class S {\n  @Autowired Plain plain;\n  @Autowired java.util.Map<String, Object> map;\n  @Autowired S self;\n}\n",
    });
    assert.deepEqual(injections(graph), []);
    assert.ok(graph.nodes.every((node) => node.properties.ambiguousInjections === undefined));
  });

  it("does not guess among several constructors", async () => {
    const graph = await scanSources({
      "Dep.java": "package app;\nimport org.springframework.stereotype.Component;\n@Component class Dep {}\n",
      "Two.java": "package app;\nimport org.springframework.stereotype.Component;\n@Component class Two {\n  Two(Dep d) {}\n  Two() {}\n}\n",
    });
    assert.deepEqual(injections(graph), []);
  });
});

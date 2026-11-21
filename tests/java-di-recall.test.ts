import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

function injections(graph: Graph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "INJECTS")
    .map((rel) => `${byId.get(rel.from)!.properties.name} -> ${byId.get(rel.to)!.properties.name} ${rel.properties.fieldName} ${rel.properties.via}`)
    .sort();
}

async function scanSources(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-di-recall-"));
  try {
    await mkdir(path.join(dir, "src/main/java/app"), { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, "src/main/java/app", name), text);
    return await buildCodeGraph(dir, { continueOnError: false });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REPO = `package app;\npublic interface Repo {}\n`;
const SERVICE = `package app;\npublic interface Svc {}\n`;

describe("Java DI recall", () => {
  it("scans ConstraintValidator implementers and @Bean return classes", async () => {
    const graph = await scanSources({
      "Repo.java": REPO,
      "RepoImpl.java": `package app;\nimport org.springframework.stereotype.Repository;\n@Repository\npublic class RepoImpl implements Repo {}\n`,
      "Valid.java": `package app;\nimport javax.validation.ConstraintValidator;\nimport org.springframework.beans.factory.annotation.Autowired;\nclass Valid implements ConstraintValidator<Object, Object> {\n  @Autowired private Repo repo;\n}\n`,
      "Filter.java": `package app;\nimport org.springframework.beans.factory.annotation.Autowired;\npublic class Filter {\n  @Autowired private Repo repo;\n}\n`,
      "Plain.java": `package app;\nimport org.springframework.beans.factory.annotation.Autowired;\npublic class Plain {\n  @Autowired private Repo repo;\n}\n`,
      "Config.java": `package app;\nimport org.springframework.context.annotation.*;\n@Configuration\npublic class Config {\n  @Bean public Filter filter() { return new Filter(); }\n}\n`,
    });
    assert.deepEqual(injections(graph), ["Filter -> RepoImpl repo field", "Valid -> RepoImpl repo field"]);
  });

  it("links every candidate when all are @Profile-gated, narrowed by the consumer's profile", async () => {
    const graph = await scanSources({
      "Repo.java": REPO,
      "JdbcRepo.java": `package app;\nimport org.springframework.context.annotation.Profile;\nimport org.springframework.stereotype.Repository;\n@Repository @Profile("jdbc")\npublic class JdbcRepo implements Repo {}\n`,
      "JpaRepo.java": `package app;\nimport org.springframework.context.annotation.Profile;\nimport org.springframework.stereotype.Repository;\n@Repository @Profile("jpa")\npublic class JpaRepo implements Repo {}\n`,
      "Service1.java": `package app;\nimport org.springframework.stereotype.Service;\n@Service\npublic class Service1 {\n  public Service1(Repo repo) {}\n}\n`,
      "Dependent.java": `package app;\nimport org.springframework.context.annotation.Profile;\nimport org.springframework.stereotype.Repository;\n@Repository @Profile("jdbc")\npublic class Dependent {\n  public Dependent(Repo repo) {}\n}\n`,
    });
    assert.deepEqual(injections(graph), ["Dependent -> JdbcRepo repo constructor", "Service1 -> JdbcRepo repo constructor", "Service1 -> JpaRepo repo constructor"]);
  });

  it("stays silent when only some candidates are profile-gated", async () => {
    const graph = await scanSources({
      "Svc.java": SERVICE,
      "A.java": `package app;\nimport org.springframework.context.annotation.Profile;\nimport org.springframework.stereotype.Service;\n@Service @Profile("a")\npublic class A implements Svc {}\n`,
      "B.java": `package app;\nimport org.springframework.stereotype.Service;\n@Service\npublic class B implements Svc {}\n`,
      "User.java": `package app;\nimport org.springframework.stereotype.Service;\n@Service\npublic class User {\n  public User(Svc svc) {}\n}\n`,
    });
    assert.deepEqual(injections(graph), []);
  });
});

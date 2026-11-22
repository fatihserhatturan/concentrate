import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

// Phase 43 review, track F2: framework-level fixes (SimpleJdbcInsert tables, JS/TS data-access language gate, @Profile).

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

async function scan(files: Record<string, string>): Promise<Graph> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-review-f2-"));
  try {
    for (const [name, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
      await writeFile(path.join(dir, name), text);
    }
    return await buildCodeGraph(dir, { continueOnError: true, concurrency: 1, workers: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function directAccesses(graph: Graph): string[] {
  const names = new Map(graph.nodes.map((node) => [node.id, String(node.properties.name)]));
  return graph.relationships
    .filter((rel) => rel.type === "ACCESSES_DATA" && rel.properties.direct === true)
    .map((rel) => `${names.get(rel.from)}: ${names.get(rel.to)}:${String(rel.properties.operation)}`)
    .sort();
}

function injections(graph: Graph): string[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "INJECTS")
    .map((rel) => `${byId.get(rel.from)!.properties.name} -> ${byId.get(rel.to)!.properties.name} ${rel.properties.fieldName} ${rel.properties.via}`)
    .sort();
}

const IMPORTS = `import org.springframework.jdbc.core.simple.SimpleJdbcInsert;\nimport javax.sql.DataSource;\nimport java.util.Map;\n`;

describe("SimpleJdbcInsert table tracking", () => {
  it("does not leak a table configured in another method's local into a parameter or shadowing local", async () => {
    const graph = await scan({
      "src/Repo.java": `package com.acme;\n${IMPORTS}public class Repo {
  void configure(DataSource ds) { SimpleJdbcInsert insert = new SimpleJdbcInsert(ds).withTableName("owners"); insert.execute(Map.of()); }
  void viaParameter(SimpleJdbcInsert insert) { insert.execute(Map.of()); }
  void viaShadow(DataSource ds) { SimpleJdbcInsert insert = new SimpleJdbcInsert(ds); insert.execute(Map.of()); }
}
`,
    });
    assert.deepEqual(directAccesses(graph), ["configure: owners:create"]);
  });

  it("keeps the constructor-configured field attributed to the executing method", async () => {
    const graph = await scan({
      "src/Repo.java": `package com.acme;\n${IMPORTS}public class Repo {
  private final SimpleJdbcInsert insert;
  Repo(DataSource ds) { this.insert = new SimpleJdbcInsert(ds).withTableName("pets"); }
  void save() { insert.execute(Map.of()); }
}
`,
    });
    assert.deepEqual(directAccesses(graph), ["save: pets:create"]);
  });

  it("records the table at withTableName when the chain is returned or passed on", async () => {
    const graph = await scan({
      "src/Repo.java": `package com.acme;\n${IMPORTS}public class Repo {
  SimpleJdbcInsert factory(DataSource ds) { return new SimpleJdbcInsert(ds).withTableName("visits"); }
}
`,
    });
    assert.deepEqual(directAccesses(graph), ["factory: visits:create"]);
  });
});

describe("JS/TS data-access language gate", () => {
  it("keeps the ORM heuristic on Astro frontmatter and HTML inline scripts", async () => {
    const graph = await scan({
      "package.json": JSON.stringify({ name: "x", dependencies: { "@prisma/client": "5.0.0", astro: "4.0.0" } }),
      "src/pages/index.astro": `---\nimport { PrismaClient } from "@prisma/client";\nconst prisma = new PrismaClient();\nconst users = await prisma.user.findMany();\n---\n<p>{users.length}</p>\n`,
    });
    const astroFile = graph.nodes.find((node) => node.label === "File" && node.properties.relativePath === "src/pages/index.astro");
    assert.ok(astroFile);
    assert.equal(astroFile.properties.language, "astro");
    assert.ok(graph.relationships.some((rel) => rel.type === "ACCESSES_DATA"), "astro frontmatter keeps its ACCESSES_DATA");
  });
});

describe("DI @Profile evaluation", () => {
  const repo = `package app;\npublic interface Repo {}\n`;
  const impl = (name: string, profile: string) => `package app;\nimport org.springframework.context.annotation.Profile;\nimport org.springframework.stereotype.Repository;\n@Repository @Profile(${profile})\npublic class ${name} implements Repo {}\n`;
  const consumer = (profile: string) => `package app;\nimport org.springframework.context.annotation.Profile;\nimport org.springframework.stereotype.Service;\n@Service @Profile(${profile})\npublic class Consumer { public Consumer(Repo repo) {} }\n`;
  const src = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([name, text]) => [`src/main/java/app/${name}`, text]));

  it("treats `!x` as incompatible with a consumer of exactly {x}", async () => {
    const graph = await scan(src({ "Repo.java": repo, "A.java": impl("A", '"x"'), "B.java": impl("B", '"!x"'), "Consumer.java": consumer('"x"') }));
    assert.deepEqual(injections(graph), ["Consumer -> A repo constructor"]);
  });

  it("supports `&`, `|` and parentheses", async () => {
    const graph = await scan(src({ "Repo.java": repo, "A.java": impl("A", '"a & b"'), "B.java": impl("B", '"(c | d) & !a"'), "Consumer.java": consumer('"a"') }));
    assert.deepEqual(injections(graph), ["Consumer -> A repo constructor"]);
  });

  it("keeps unparseable expressions compatible with everything", async () => {
    const graph = await scan(src({ "Repo.java": repo, "A.java": impl("A", '"x"'), "B.java": impl("B", '"a &"'), "Consumer.java": consumer('"x"') }));
    assert.deepEqual(injections(graph), ["Consumer -> A repo constructor", "Consumer -> B repo constructor"]);
  });

  it("treats a set with an unresolved constant as opaque instead of narrowing it", async () => {
    const graph = await scan(src({
      "Repo.java": repo,
      "A.java": impl("A", '{"dev", Constants.X}'),
      "B.java": impl("B", '"prod"'),
      "Consumer.java": consumer('"qa"'),
    }));
    assert.deepEqual(injections(graph), ["Consumer -> A repo constructor"]);
  });

  it("uses a @Bean method's own @Profile for its parameters", async () => {
    const graph = await scan(src({
      "Repo.java": repo,
      "A.java": impl("A", '"a"'),
      "B.java": impl("B", '"b"'),
      "Config.java": `package app;\nimport org.springframework.context.annotation.*;\n@Configuration\npublic class Config {\n  @Bean @Profile("a") public Holder holder(Repo repo) { return new Holder(); }\n}\nclass Holder {}\n`,
    }));
    assert.deepEqual(injections(graph), ["Holder -> A repo bean-parameter"]);
  });
});

import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

async function project(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "java-measurement-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text);
  }
  return directory;
}

// Fixes found by the Phase 43 measurement of the Java samples get a regression
// test here, one `it` per fix, the way tests/cpp-measurement.test.ts does.
describe("Java measurement fixes (Phase 43)", () => {
  it("resolves an import to its file and injects a constructor dependency", async () => {
    const root = await project({
      "src/main/java/app/Repo.java": `package app;
import org.springframework.stereotype.Repository;
@Repository
public class Repo {}
`,
      "src/main/java/app/Service.java": `package app;
import org.springframework.stereotype.Service;
import app.Repo;
@Service
public class Service {
  private final Repo repo;
  public Service(Repo repo) { this.repo = repo; }
}
`,
    });
    const graph = await buildCodeGraph(root, { continueOnError: false });
    assert.ok(graph.relationships.some((rel) => rel.type === "RESOLVES_TO" && rel.from.includes(":import:") && rel.to === "file:src/main/java/app/Repo.java"));
    const injects = graph.relationships.filter((rel) => rel.type === "INJECTS");
    assert.equal(injects.length, 1);
    assert.equal(injects[0]!.properties.via, "constructor");
  });
});

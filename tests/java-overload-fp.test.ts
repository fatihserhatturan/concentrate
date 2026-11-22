import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

async function project(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "java-overload-fp-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text);
  }
  return directory;
}

async function targets(files: Record<string, string>, file: string, line: number): Promise<string[]> {
  const graph = await buildCodeGraph(await project(files), { continueOnError: false });
  const calls = new Set(graph.nodes.filter((node) => node.label === "Call" && node.id.includes(`file:${file}`) && node.properties.line === line).map((node) => node.id));
  const names = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.relationships
    .filter((rel) => rel.type === "CALL_RESOLVES_TO" && calls.has(rel.from))
    .map((rel) => `${String(names.get(rel.to)?.properties.name)}@${String(names.get(rel.to)?.properties.line)}`)
    .sort();
}

describe("Java overloads over unscanned parameter types (Phase 43 review)", () => {
  const files = (argument: string) => ({
    "src/main/java/p/Mapper.java": `package p;
import gen.AlphaDto;
import gen.BetaDto;
public interface Mapper {
  String convert(AlphaDto alpha);
  String convert(BetaDto beta);
}
`,
    "src/main/java/p/Use.java": `package p;
import gen.AlphaDto;
import gen.BetaDto;
public class Use {
  private Mapper mapper;
  public String run(AlphaDto alpha, BetaDto beta) {
    return mapper.convert(${argument});
  }
}
`,
  });

  it("picks the overload whose unscanned parameter type is the argument's declared type", async () => {
    assert.deepEqual(await targets(files("beta"), "src/main/java/p/Use.java", 7), ["convert@6"]);
    assert.deepEqual(await targets(files("alpha"), "src/main/java/p/Use.java", 7), ["convert@5"]);
  });

  it("keeps every overload when the argument type cannot be compared", async () => {
    assert.deepEqual(await targets(files("make()"), "src/main/java/p/Use.java", 7), ["convert@5", "convert@6"]);
  });
});

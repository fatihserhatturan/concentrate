import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { CypherError } from "../src/adapters/store/cypher/errors.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";
import { isCodeLanguage, type SupportedLanguage } from "../src/core/scan/language.js";
import { assertGolden } from "./helpers/golden.js";
import { corpusGoldenPath, formatCorpusResults, readCorpus, runCorpus } from "./helpers/cypher-corpus.js";

const fixturesRoot = path.join(import.meta.dirname, "../fixtures");
const corpus = await readCorpus();
const workRoot = await mkdtemp(path.join(os.tmpdir(), "concentrate-golden-cypher-"));

after(() => rm(workRoot, { recursive: true, force: true }));

// The recordings were made with Kuzu 0.11.3 before it was removed, and are the
// reference for the built-in engine: they are never regenerated from it.
describe("Cypher conformance corpus", () => {
  for (const fixture of corpus.fixtures) {
    it(fixture, async () => {
      const graph = codeFilesOnly(await buildCodeGraph(path.join(fixturesRoot, fixture), { continueOnError: true, concurrency: 4 }));
      const store = await GraphStore.open(path.join(workRoot, `${fixture}.graph`));
      await store.reset();
      await store.write(graph.nodes, graph.relationships);
      const results = await runCorpus(corpus.cases, (cypher, params) => store.query(cypher, params), classifyCypherError);
      await assertGolden(corpusGoldenPath(fixture), formatCorpusResults(results), { readOnly: true });
    });
  }
});

function classifyCypherError(error: unknown) {
  if (error instanceof CypherError) return error.kind;
  throw error;
}


// The recordings predate the File nodes of non-code files (JSON, styles,
// docs, …) and are never regenerated, so the corpus runs over the code files
// and the directories that still hold one.
function codeFilesOnly(graph: { nodes: GraphNode[]; relationships: GraphRelationship[] }) {
  const dropped = new Set(graph.nodes
    .filter((node) => node.label === "File" && !isCodeLanguage(node.properties.language as SupportedLanguage))
    .map((node) => node.id));
  let nodes = graph.nodes.filter((node) => !dropped.has(node.id));
  let relationships = graph.relationships.filter((rel) => !dropped.has(rel.from) && !dropped.has(rel.to));
  for (;;) {
    const parents = new Set(relationships.filter((rel) => rel.type === "CONTAINS_FILE" || rel.type === "CONTAINS_DIRECTORY").map((rel) => rel.from));
    const empty = new Set(nodes.filter((node) => node.label === "Directory" && !parents.has(node.id)).map((node) => node.id));
    if (empty.size === 0) return { nodes, relationships };
    nodes = nodes.filter((node) => !empty.has(node.id));
    relationships = relationships.filter((rel) => !empty.has(rel.from) && !empty.has(rel.to));
  }
}

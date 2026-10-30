/**
 * Accuracy report: precision and recall of routes, call resolution, data
 * access, UI components, their renders, UI pages and frontend requests
 * against hand-written labels in bench/labels/<sample>.json.
 *
 *   npm run bench:accuracy -- [--sample name] [--details] [--json out.json]
 *
 * Needs the samples (`npm run samples:fetch`). See docs/accuracy.md for how
 * the labels were written.
 */
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { readSampleManifest, samplesDirectory } from "../src/adapters/cli/smoke.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { compareCalls, compareComponents, compareDataAccess, comparePages, compareRenders, compareRequests, compareRoutes, sumScores, type Labels, type RouteScore, type Score } from "./accuracy/compare.js";

const { values } = parseArgs({
  options: {
    sample: { type: "string" },
    details: { type: "boolean", default: false },
    json: { type: "string" },
  },
});

const labelsDirectory = new URL("../bench/labels/", import.meta.url);
const kinds = ["routes", "calls", "dataAccess", "components", "renders", "pages", "requests"] as const;
type Kind = (typeof kinds)[number];

const labelFiles = (await readdir(labelsDirectory)).filter((file) => file.endsWith(".json")).sort();
const manifest = await readSampleManifest();
type Scores = { routes?: RouteScore; calls?: Score; dataAccess?: Score; components?: Score; renders?: Score; pages?: Score; requests?: Score };
const results: Array<{ sample: string; scores: Scores }> = [];

for (const labelFile of labelFiles) {
  const labels = JSON.parse(await readFile(new URL(labelFile, labelsDirectory), "utf8")) as Labels;
  if (values.sample && labels.sample !== values.sample) continue;
  const projectPath = path.join(samplesDirectory(), labels.sample);
  if (!existsSync(projectPath)) {
    console.error(`Sample ${labels.sample} is missing at ${projectPath}; run \`npm run samples:fetch\`.`);
    process.exit(1);
  }
  const entry = manifest.find((sample) => sample.name === labels.sample);
  const graph = await buildCodeGraph(projectPath, { continueOnError: entry?.continueOnError === true, apiOrigins: entry?.apiOrigins });
  const scores: Scores = {};
  if (labels.routes) scores.routes = compareRoutes(graph, labels.routes);
  if (labels.calls) scores.calls = compareCalls(graph, labels.calls);
  if (labels.dataAccess) scores.dataAccess = compareDataAccess(graph, labels.dataAccess);
  if (labels.components) scores.components = compareComponents(graph, labels.components);
  if (labels.renders) scores.renders = compareRenders(graph, labels.renders);
  if (labels.pages) scores.pages = comparePages(graph, labels.pages);
  if (labels.requests) scores.requests = compareRequests(graph, labels.requests);
  results.push({ sample: labels.sample, scores });
}

const percent = (value: number | null) => (value === null ? "–" : `${(value * 100).toFixed(1)}%`);
const titles: Record<Kind, string> = {
  routes: "Routes",
  calls: "Call resolution",
  dataAccess: "Data access",
  components: "Components",
  renders: "Component renders",
  pages: "Pages",
  requests: "API requests",
};

// Routes get one more column: detected routes whose full path is right.
const sumPaths = (scores: readonly RouteScore[]) => ({
  correct: scores.reduce((total, s) => total + s.paths.correct, 0),
  total: scores.reduce((total, s) => total + s.paths.total, 0),
});
const pathCell = (paths: { correct: number; total: number }) =>
  `${percent(paths.total === 0 ? null : paths.correct / paths.total)} (${paths.correct}/${paths.total})`;

const lines: string[] = [];
for (const kind of kinds) {
  const rows = results.filter((result) => result.scores[kind]);
  if (rows.length === 0) continue;
  const routes = kind === "routes";
  lines.push(
    `### ${titles[kind]}`,
    "",
    `| Sample | Labels | TP | FP | FN | Precision | Recall |${routes ? " Full path |" : ""}`,
    `| --- | ---: | ---: | ---: | ---: | ---: | ---: |${routes ? " ---: |" : ""}`,
  );
  for (const { sample, scores } of rows) {
    const s = scores[kind]!;
    const extra = routes ? ` ${pathCell(scores.routes!.paths)} |` : "";
    lines.push(`| ${sample} | ${s.tp + s.fn} | ${s.tp} | ${s.fp} | ${s.fn} | ${percent(s.precision)} | ${percent(s.recall)} |${extra}`);
  }
  const total = sumScores(rows.map((row) => row.scores[kind]!));
  const extra = routes ? ` **${pathCell(sumPaths(rows.map((row) => row.scores.routes!)))}** |` : "";
  lines.push(`| **all** | ${total.tp + total.fn} | ${total.tp} | ${total.fp} | ${total.fn} | **${percent(total.precision)}** | **${percent(total.recall)}** |${extra}`, "");
}
console.log(lines.join("\n"));

if (values.details) {
  for (const { sample, scores } of results) {
    for (const kind of kinds) {
      const s = scores[kind];
      const wrongPaths = kind === "routes" ? scores.routes?.paths.wrong ?? [] : [];
      if (!s || (s.fp === 0 && s.fn === 0 && wrongPaths.length === 0)) continue;
      console.log(`\n## ${sample} ${titles[kind]}`);
      for (const entry of s.falsePositives) console.log(`  FP ${entry}`);
      for (const entry of s.falseNegatives) console.log(`  FN ${entry}`);
      for (const entry of wrongPaths) console.log(`  PATH ${entry}`);
    }
  }
}

if (values.json) {
  const strip = (s: Score) => ({
    tp: s.tp,
    fp: s.fp,
    fn: s.fn,
    precision: s.precision,
    recall: s.recall,
    ...("paths" in s ? { fullPath: { correct: (s as RouteScore).paths.correct, total: (s as RouteScore).paths.total } } : {}),
  });
  await writeFile(values.json, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    samples: results.map(({ sample, scores }) => ({ sample, ...Object.fromEntries(Object.entries(scores).map(([kind, s]) => [kind, strip(s!)])) })),
    totals: Object.fromEntries(kinds.flatMap((kind) => {
      const rows = results.flatMap((result) => (result.scores[kind] ? [result.scores[kind]!] : []));
      if (rows.length === 0) return [];
      const total = strip(sumScores(rows));
      return [[kind, kind === "routes" ? { ...total, fullPath: sumPaths(rows as RouteScore[]) } : total]];
    })),
  }, null, 2)}\n`);
}

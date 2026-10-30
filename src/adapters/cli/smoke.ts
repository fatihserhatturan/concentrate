import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { GRAPH_SCHEMA_VERSION, openGraphStore } from "../../composition/graph-store.js";
import type { IQueryEngine } from "../../core/contracts/query-engine.js";
import type { BuildCodeGraphResult, FileClassificationCounts, ScanReport, ScanStatus } from "../../core/scan/index.js";
import { formatNormalizedGraph, normalizeGraph } from "../../core/graph/normalize.js";
import { scanOrchestrator } from "../../composition/orchestrator.js";

export type SmokeSuite = "standing" | "internet";

type SmokeOptions = {
  suite: string;
  report: string;
  allowMissing: boolean;
  semanticSamples?: number;
  incrementalBenchmark?: boolean;
};

export type SmokeSample = {
  name: string;
  suite: SmokeSuite;
  projectPath: string;
  databasePath: string;
  continueOnError?: boolean;
  exclude?: string[];
  expected: SmokeExpected;
};

export type SmokeExpected = {
  status?: ScanStatus;
  discoveredFiles: number;
  supportedFiles: number;
  parsedFiles: number;
  failedFiles: number;
  resolvedImports: number;
  unresolvedRelativeImports: number;
  nodes: number;
  relationships: number;
  fileClassifications: FileClassificationCounts;
  graph: Partial<Record<SmokeMetricName, number>>;
};

export type SmokeMetricName =
  | "schemaVersion"
  | "routes"
  | "routesWithFullPath"
  | "routeHandledBy"
  | "routeLifecycleStep"
  | "lifecyclePrecedes"
  | "moduleControls"
  | "moduleProvides"
  | "injects"
  | "entrypoints"
  | "envVars"
  | "configValues"
  | "dataModels";

export type SmokeSampleResult = {
  name: string;
  suite: SmokeSuite;
  projectPath: string;
  databasePath: string;
  status: "passed" | "failed" | "skipped";
  scan?: ScanReport;
  nodes?: number;
  relationships?: number;
  graph?: Partial<Record<SmokeMetricName, number>>;
  semanticSamples?: SemanticSamples;
  incrementalBenchmark?: IncrementalBenchmarkResult;
  failures: string[];
};

export type SmokeReport = {
  status: "passed" | "failed";
  generatedAt: string;
  results: SmokeSampleResult[];
};

export type SemanticSamples = {
  routes: SemanticRouteSample[];
  entrypoints: SemanticEntrypointSample[];
  envConfig: SemanticEnvConfigSample[];
  dataAccess: SemanticDataAccessSample[];
  review: SemanticReviewNotes;
};

export type SemanticRouteSample = {
  file: string | null;
  line: number | null;
  method: string | null;
  path: string | null;
  fullPath: string | null;
  framework: string | null;
  handler: string | null;
};

export type SemanticEntrypointSample = {
  file: string | null;
  line: number | null;
  kind: string | null;
  trigger: string | null;
  library: string | null;
  handler: string | null;
};

export type SemanticEnvConfigSample = {
  file: string | null;
  line: number | null;
  kind: "env" | "config";
  name: string | null;
  value: string | null;
  valueType: string | null;
  consumer: string | null;
};

export type SemanticDataAccessSample = {
  file: string | null;
  line: number | null;
  sourceKind: string | null;
  sourceName: string | null;
  model: string | null;
  library: string | null;
  operation: string | null;
  expression: string | null;
};

export type SemanticReviewNotes = {
  falsePositiveFindings: string[];
  falseNegativeFindings: string[];
  notes: string[];
};

// A no-change rescan with a warm parse cache: it must produce the same graph
// as the full scan while parsing nothing.
export type IncrementalBenchmarkResult = {
  status: "passed" | "failed";
  fullScanMs: number;
  coldCacheScanMs: number;
  warmCacheScanMs: number;
  parseCache: ScanReport["parseCache"];
  failures: string[];
};

export type SampleManifestEntry = {
  name: string;
  suite: SmokeSuite;
  repo: string;
  sha: string;
  continueOnError?: boolean;
  exclude?: string[];
};

type SampleExpectation = Pick<SmokeSample, "name" | "suite" | "expected">;

const sampleManifestUrl = new URL("../../../scripts/samples.json", import.meta.url);

/** Where `npm run samples:fetch` puts the pinned sample repositories. */
export function samplesDirectory(): string {
  return path.resolve(process.env.CONCENTRATE_SAMPLES_DIR ?? ".concentrate/samples");
}

export async function readSampleManifest(): Promise<SampleManifestEntry[]> {
  const manifest = JSON.parse(await readFile(sampleManifestUrl, "utf8")) as { samples: SampleManifestEntry[] };
  return manifest.samples;
}

/** Join expected counts with the pinned manifest; every sample must appear in both. */
export function resolveSamples(expectations: SampleExpectation[], manifest: SampleManifestEntry[]): SmokeSample[] {
  const byName = new Map(manifest.map((entry) => [entry.name, entry]));
  const missing = expectations.filter((sample) => !byName.has(sample.name)).map((sample) => sample.name);
  const unexpected = manifest.filter((entry) => !expectations.some((sample) => sample.name === entry.name))
    .map((entry) => entry.name);
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(`scripts/samples.json and smoke expectations disagree; missing: [${missing.join(", ")}], unexpected: [${unexpected.join(", ")}]`);
  }

  return expectations.map((sample) => {
    const entry = byName.get(sample.name)!;
    return {
      ...sample,
      projectPath: path.join(samplesDirectory(), sample.name),
      databasePath: `.concentrate/${sample.name}.graph`,
      continueOnError: entry.continueOnError,
      exclude: entry.exclude,
    };
  });
}

export const defaultSampleExpectations: SampleExpectation[] = [
  {
    name: "express",
    suite: "standing",
    expected: {
      discoveredFiles: 213,
      supportedFiles: 141,
      parsedFiles: 141,
      failedFiles: 0,
      resolvedImports: 158,
      unresolvedRelativeImports: 0,
      nodes: 12879,
      relationships: 14052,
      fileClassifications: { production: 50, test: 91, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 91,
        routesWithFullPath: 57,
        routeHandledBy: 65,
        routeLifecycleStep: 65,
        lifecyclePrecedes: 9,
        envVars: 2,
        configValues: 5,
        entrypoints: 0,
        dataModels: 0,
      },
    },
  },
  {
    name: "fastify",
    suite: "standing",
    expected: {
      discoveredFiles: 45,
      supportedFiles: 18,
      parsedFiles: 18,
      failedFiles: 0,
      resolvedImports: 10,
      unresolvedRelativeImports: 1,
      nodes: 398,
      relationships: 454,
      fileClassifications: { production: 11, test: 7, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 1,
        routesWithFullPath: 1,
        routeHandledBy: 1,
        routeLifecycleStep: 1,
        lifecyclePrecedes: 0,
        envVars: 2,
        configValues: 0,
        entrypoints: 0,
        dataModels: 0,
      },
    },
  },
  {
    name: "nestjs-starter",
    suite: "standing",
    expected: {
      discoveredFiles: 16,
      supportedFiles: 7,
      parsedFiles: 7,
      failedFiles: 0,
      resolvedImports: 7,
      unresolvedRelativeImports: 0,
      nodes: 85,
      relationships: 112,
      fileClassifications: { production: 5, test: 2, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 1,
        routesWithFullPath: 1,
        moduleControls: 1,
        moduleProvides: 1,
        injects: 1,
        routeLifecycleStep: 0,
        envVars: 0,
        configValues: 9,
        entrypoints: 0,
        dataModels: 0,
      },
    },
  },
  {
    name: "ky",
    suite: "standing",
    expected: {
      // 68 in the original 2026-05 local clone, which had one extra untracked file.
      discoveredFiles: 67,
      supportedFiles: 52,
      parsedFiles: 52,
      failedFiles: 0,
      resolvedImports: 134,
      unresolvedRelativeImports: 0,
      nodes: 7013,
      relationships: 8497,
      fileClassifications: { production: 29, test: 23, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 0,
        routesWithFullPath: 0,
        envVars: 2,
        configValues: 10,
        entrypoints: 0,
        dataModels: 0,
      },
    },
  },
  {
    name: "internet-node-express-firebase-mongodb",
    suite: "internet",
    expected: {
      discoveredFiles: 40,
      supportedFiles: 24,
      parsedFiles: 24,
      failedFiles: 0,
      resolvedImports: 22,
      unresolvedRelativeImports: 0,
      nodes: 515,
      relationships: 643,
      fileClassifications: { production: 20, test: 3, fixture: 0, support: 0, generated: 1 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 7,
        envVars: 2,
        configValues: 14,
        dataModels: 1,
      },
    },
  },
  {
    name: "internet-node-express-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 67,
      supportedFiles: 39,
      parsedFiles: 39,
      failedFiles: 0,
      resolvedImports: 49,
      unresolvedRelativeImports: 0,
      nodes: 696,
      relationships: 1254,
      fileClassifications: { production: 29, test: 7, fixture: 0, support: 3, generated: 0 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 26,
        envVars: 4,
        configValues: 9,
        dataModels: 4,
      },
    },
  },
  {
    name: "internet-nest",
    suite: "internet",
    expected: {
      discoveredFiles: 2115,
      supportedFiles: 1718,
      parsedFiles: 1718,
      failedFiles: 0,
      resolvedImports: 4920,
      unresolvedRelativeImports: 1,
      nodes: 53037,
      relationships: 71796,
      fileClassifications: { production: 985, test: 353, fixture: 380, support: 0, generated: 0 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 309,
        entrypoints: 13,
        envVars: 9,
        configValues: 144,
        dataModels: 7,
      },
    },
  },
  {
    name: "internet-react-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 45,
      supportedFiles: 39,
      parsedFiles: 39,
      failedFiles: 0,
      resolvedImports: 82,
      unresolvedRelativeImports: 0,
      nodes: 684,
      relationships: 1061,
      fileClassifications: { production: 39, test: 0, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 0,
      },
    },
  },
  {
    name: "internet-nextjs-taxonomy",
    suite: "internet",
    expected: {
      discoveredFiles: 188,
      supportedFiles: 131,
      parsedFiles: 131,
      failedFiles: 0,
      resolvedImports: 259,
      unresolvedRelativeImports: 17,
      nodes: 2200,
      relationships: 3702,
      fileClassifications: { production: 131, test: 0, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 9,
        entrypoints: 1,
      },
    },
  },
];

export async function smokeCommand(options: SmokeOptions): Promise<void> {
  const samples = selectSamples(resolveSamples(defaultSampleExpectations, await readSampleManifest()), options.suite);
  const report = await runSmokeValidation(samples, {
    allowMissing: options.allowMissing,
    reportPath: options.report,
    semanticSampleLimit: options.semanticSamples,
    incrementalBenchmark: options.incrementalBenchmark ?? false,
  });

  printSmokeReport(report);
  if (report.status === "failed") {
    process.exitCode = 1;
  }
}

export async function runSmokeValidation(
  samples: SmokeSample[],
  options: {
    allowMissing: boolean;
    reportPath: string;
    semanticSampleLimit?: number;
    incrementalBenchmark?: boolean;
  },
): Promise<SmokeReport> {
  const results: SmokeSampleResult[] = [];

  for (const sample of samples) {
    results.push(await runSmokeSample(
      sample,
      options.allowMissing,
      options.semanticSampleLimit ?? 10,
      options.incrementalBenchmark ?? false,
    ));
  }

  const report: SmokeReport = {
    status: results.every((result) => result.status === "passed" || result.status === "skipped") ? "passed" : "failed",
    generatedAt: new Date().toISOString(),
    results,
  };

  const reportPath = resolvePath(options.reportPath);
  await mkdir(path.dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  return report;
}

async function runSmokeSample(
  sample: SmokeSample,
  allowMissing: boolean,
  semanticSampleLimit: number,
  incrementalBenchmark: boolean,
): Promise<SmokeSampleResult> {
  const projectPath = resolvePath(sample.projectPath);
  const databasePath = resolvePath(sample.databasePath);
  const failures: string[] = [];

  if (!await pathExists(projectPath)) {
    const result: SmokeSampleResult = {
      name: sample.name,
      suite: sample.suite,
      projectPath,
      databasePath,
      status: allowMissing ? "skipped" : "failed",
      failures: [`Project path does not exist: ${projectPath}`],
    };
    return result;
  }

  const fullScanStartedAt = performance.now();
  const graph = await scanOrchestrator.buildGraph(projectPath, {
    continueOnError: sample.continueOnError ?? false,
    exclude: sample.exclude,
  });
  const fullScanMs = elapsedMs(fullScanStartedAt);

  const writer = await openGraphStore(databasePath);
  const fullWriteStartedAt = performance.now();
  try {
    await writer.reset();
    await writer.write(graph.nodes, graph.relationships);
  } finally {
    await writer.close();
  }
  const fullWriteMs = elapsedMs(fullWriteStartedAt);

  const graphMetrics = await readGraphMetrics(databasePath, sample.expected.graph);
  const semanticSamples = await readSemanticSamples(databasePath, semanticSampleLimit);
  compareScan(sample.expected, graph.report, graph.nodes.length, graph.relationships.length, failures);
  compareGraph(sample.expected.graph, graphMetrics, failures);
  const incrementalBenchmarkResult = incrementalBenchmark
    ? await runIncrementalBenchmark(sample, projectPath, graph, fullScanMs)
    : undefined;
  if (incrementalBenchmarkResult?.status === "failed") {
    failures.push(...incrementalBenchmarkResult.failures.map((failure) => `incrementalBenchmark.${failure}`));
  }

  return {
    name: sample.name,
    suite: sample.suite,
    projectPath,
    databasePath,
    status: failures.length === 0 ? "passed" : "failed",
    scan: graph.report,
    nodes: graph.nodes.length,
    relationships: graph.relationships.length,
    graph: graphMetrics,
    semanticSamples,
    incrementalBenchmark: incrementalBenchmarkResult,
    failures,
  };
}

async function runIncrementalBenchmark(
  sample: SmokeSample,
  projectPath: string,
  fullGraph: BuildCodeGraphResult,
  fullScanMs: number,
): Promise<IncrementalBenchmarkResult> {
  const failures: string[] = [];
  const cacheDirectory = await mkdtemp(path.join(os.tmpdir(), "concentrate-parse-cache-"));
  const scan = () => scanOrchestrator.buildGraph(projectPath, {
    continueOnError: sample.continueOnError ?? false,
    exclude: sample.exclude,
    cacheDirectory,
  });

  try {
    const coldStartedAt = performance.now();
    await scan();
    const coldCacheScanMs = elapsedMs(coldStartedAt);

    const warmStartedAt = performance.now();
    const warmGraph = await scan();
    const warmCacheScanMs = elapsedMs(warmStartedAt);

    // Files that fail to parse are never cached, so they are parsed again.
    const cache = warmGraph.report.parseCache;
    const expectedMisses = warmGraph.report.failedFiles.length;
    if (cache.misses !== expectedMisses) {
      failures.push(`parseCache.misses: expected ${expectedMisses}, got ${cache.misses}`);
    }
    if (formatNormalizedGraph(normalizeGraph(warmGraph)) !== formatNormalizedGraph(normalizeGraph(fullGraph))) {
      failures.push("graph: warm-cache scan differs from the full scan");
    }

    return {
      status: failures.length === 0 ? "passed" : "failed",
      fullScanMs,
      coldCacheScanMs,
      warmCacheScanMs,
      parseCache: cache,
      failures,
    };
  } finally {
    await rm(cacheDirectory, { recursive: true, force: true });
  }
}

async function readSemanticSamples(databasePath: string, limit: number): Promise<SemanticSamples> {
  const writer = await openGraphStore(databasePath);
  try {
    const routes = await readRouteSamples(writer, limit);
    const entrypoints = await readEntrypointSamples(writer, limit);
    const envConfig = await readEnvConfigSamples(writer, limit);
    const dataAccess = await readDataAccessSamples(writer, limit);

    return {
      routes,
      entrypoints,
      envConfig,
      dataAccess,
      review: {
        falsePositiveFindings: [],
        falseNegativeFindings: [],
        notes: [],
      },
    };
  } finally {
    await writer.close();
  }
}

async function readRouteSamples(writer: IQueryEngine, limit: number): Promise<SemanticRouteSample[]> {
  const rows = await writer.query(`
    MATCH (file:File)-[:DECLARES_ROUTE]->(route:Route)
    OPTIONAL MATCH (route)-[:ROUTE_HANDLED_BY]->(handler:Function)
    RETURN file.relativePath AS file,
      route.line AS line,
      route.method AS method,
      route.path AS path,
      route.fullPath AS fullPath,
      route.framework AS framework,
      handler.name AS handler
    ORDER BY file.relativePath, route.line
    LIMIT ${limit}
  `) as Record<string, unknown>[];

  return rows.map((row) => ({
    file: nullableString(row.file),
    line: nullableNumber(row.line),
    method: nullableString(row.method),
    path: nullableString(row.path),
    fullPath: nullableString(row.fullPath),
    framework: nullableString(row.framework),
    handler: nullableString(row.handler),
  }));
}

async function readEntrypointSamples(writer: IQueryEngine, limit: number): Promise<SemanticEntrypointSample[]> {
  const rows = await writer.query(`
    MATCH (file:File)-[:DECLARES_ENTRYPOINT]->(entrypoint:EntryPoint)
    OPTIONAL MATCH (entrypoint)-[:ENTRYPOINT_HANDLED_BY]->(handler:Function)
    RETURN file.relativePath AS file,
      entrypoint.line AS line,
      entrypoint.kind AS kind,
      entrypoint.trigger AS trigger,
      entrypoint.library AS library,
      handler.name AS handler
    ORDER BY file.relativePath, entrypoint.line
    LIMIT ${limit}
  `) as Record<string, unknown>[];

  return rows.map((row) => ({
    file: nullableString(row.file),
    line: nullableNumber(row.line),
    kind: nullableString(row.kind),
    trigger: nullableString(row.trigger),
    library: nullableString(row.library),
    handler: nullableString(row.handler),
  }));
}

async function readEnvConfigSamples(writer: IQueryEngine, limit: number): Promise<SemanticEnvConfigSample[]> {
  const configLimit = Math.ceil(limit / 2);
  const envLimit = Math.floor(limit / 2);
  const configRows = await writer.query(`
    MATCH (file:File)-[:DECLARES_CONFIG_FILE]->(config:ConfigValue)
    OPTIONAL MATCH (consumer)-[rel:CONSUMES_CONFIG_FILE]->(config)
    RETURN file.relativePath AS file,
      config.line AS line,
      config.name AS name,
      config.value AS value,
      config.valueType AS valueType,
      consumer.name AS consumer
    ORDER BY file.relativePath, config.line
    LIMIT ${configLimit}
  `) as Record<string, unknown>[];

  const envRows = await writer.query(`
    MATCH (file:File)-[rel:USES_ENV_FILE]->(env:EnvVar)
    RETURN file.relativePath AS file,
      rel.line AS line,
      env.name AS name,
      rel.access AS access
    ORDER BY file.relativePath, rel.line
    LIMIT ${envLimit}
  `) as Record<string, unknown>[];

  return [
    ...configRows.map((row): SemanticEnvConfigSample => ({
      file: nullableString(row.file),
      line: nullableNumber(row.line),
      kind: "config",
      name: nullableString(row.name),
      value: nullableString(row.value),
      valueType: nullableString(row.valueType),
      consumer: nullableString(row.consumer),
    })),
    ...envRows.map((row): SemanticEnvConfigSample => ({
      file: nullableString(row.file),
      line: nullableNumber(row.line),
      kind: "env",
      name: nullableString(row.name),
      value: nullableString(row.access),
      valueType: null,
      consumer: nullableString(row.file),
    })),
  ];
}

async function readDataAccessSamples(writer: IQueryEngine, limit: number): Promise<SemanticDataAccessSample[]> {
  const functionLimit = Math.ceil(limit / 2);
  const methodLimit = Math.floor(limit / 2);
  const functionRows = await writer.query(`
    MATCH (source)-[rel:ACCESSES_DATA_FUNCTION]->(model:DataModel)
    OPTIONAL MATCH (file:File)-[:DEFINES_FUNCTION]->(source)
    RETURN file.relativePath AS file,
      rel.line AS line,
      'Function' AS sourceKind,
      source.name AS sourceName,
      model.name AS model,
      model.library AS library,
      rel.operation AS operation,
      rel.expression AS expression
    ORDER BY file.relativePath, rel.line
    LIMIT ${functionLimit}
  `) as Record<string, unknown>[];

  const methodRows = await writer.query(`
    MATCH (source)-[rel:ACCESSES_DATA_FUNCTION]->(model:DataModel)
    MATCH (file:File)-[:DEFINES_CLASS]->(class:Class)-[:DEFINES_METHOD]->(source)
    RETURN file.relativePath AS file,
      rel.line AS line,
      'Method' AS sourceKind,
      source.name AS sourceName,
      model.name AS model,
      model.library AS library,
      rel.operation AS operation,
      rel.expression AS expression
    ORDER BY file.relativePath, rel.line
    LIMIT ${methodLimit}
  `) as Record<string, unknown>[];

  return [...functionRows, ...methodRows].slice(0, limit).map((row) => ({
    file: nullableString(row.file),
    line: nullableNumber(row.line),
    sourceKind: nullableString(row.sourceKind),
    sourceName: nullableString(row.sourceName),
    model: nullableString(row.model),
    library: nullableString(row.library),
    operation: nullableString(row.operation),
    expression: nullableString(row.expression),
  }));
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

async function readGraphMetrics(
  databasePath: string,
  expected: Partial<Record<SmokeMetricName, number>>,
): Promise<Partial<Record<SmokeMetricName, number>>> {
  const writer = await openGraphStore(databasePath);
  try {
    const metrics: Partial<Record<SmokeMetricName, number>> = {};
    if ("schemaVersion" in expected) metrics.schemaVersion = await writer.schemaVersion() ?? -1;
    if ("routes" in expected) metrics.routes = await queryCount(writer, "MATCH (r:Route) RETURN count(r) AS count");
    if ("routesWithFullPath" in expected) {
      metrics.routesWithFullPath = await queryCount(
        writer,
        "MATCH (r:Route) WHERE r.fullPath IS NOT NULL RETURN count(r) AS count",
      );
    }
    if ("routeHandledBy" in expected) {
      metrics.routeHandledBy = await queryCount(writer, "MATCH ()-[r:ROUTE_HANDLED_BY]->() RETURN count(r) AS count");
    }
    if ("routeLifecycleStep" in expected) {
      metrics.routeLifecycleStep = await queryCount(writer, "MATCH ()-[r:ROUTE_LIFECYCLE_STEP]->() RETURN count(r) AS count");
    }
    if ("lifecyclePrecedes" in expected) {
      metrics.lifecyclePrecedes = await queryCount(writer, "MATCH ()-[r:LIFECYCLE_PRECEDES]->() RETURN count(r) AS count");
    }
    if ("moduleControls" in expected) {
      metrics.moduleControls = await queryCount(writer, "MATCH ()-[r:MODULE_CONTROLS]->() RETURN count(r) AS count");
    }
    if ("moduleProvides" in expected) {
      metrics.moduleProvides = await queryCount(writer, "MATCH ()-[r:MODULE_PROVIDES]->() RETURN count(r) AS count");
    }
    if ("injects" in expected) metrics.injects = await queryCount(writer, "MATCH ()-[r:INJECTS]->() RETURN count(r) AS count");
    if ("entrypoints" in expected) metrics.entrypoints = await queryCount(writer, "MATCH (n:EntryPoint) RETURN count(n) AS count");
    if ("envVars" in expected) metrics.envVars = await queryCount(writer, "MATCH (n:EnvVar) RETURN count(n) AS count");
    if ("configValues" in expected) metrics.configValues = await queryCount(writer, "MATCH (n:ConfigValue) RETURN count(n) AS count");
    if ("dataModels" in expected) metrics.dataModels = await queryCount(writer, "MATCH (n:DataModel) RETURN count(n) AS count");
    return metrics;
  } finally {
    await writer.close();
  }
}

async function queryCount(writer: IQueryEngine, cypher: string): Promise<number> {
  const rows = await writer.query(cypher) as Array<{ count?: unknown }>;
  const count = rows[0]?.count;
  return typeof count === "number" ? count : -1;
}

function compareScan(
  expected: SmokeExpected,
  scan: ScanReport,
  nodes: number,
  relationships: number,
  failures: string[],
): void {
  compareValue("status", expected.status ?? "success", scan.status, failures);
  compareValue("discoveredFiles", expected.discoveredFiles, scan.discoveredFiles, failures);
  compareValue("supportedFiles", expected.supportedFiles, scan.supportedFiles, failures);
  compareValue("parsedFiles", expected.parsedFiles, scan.parsedFiles, failures);
  compareValue("failedFiles", expected.failedFiles, scan.failedFiles.length, failures);
  compareValue("resolvedImports", expected.resolvedImports, scan.resolvedImports, failures);
  compareValue("unresolvedRelativeImports", expected.unresolvedRelativeImports, scan.unresolvedRelativeImports, failures);
  compareValue("nodes", expected.nodes, nodes, failures);
  compareValue("relationships", expected.relationships, relationships, failures);

  for (const [key, value] of Object.entries(expected.fileClassifications)) {
    compareValue(`fileClassifications.${key}`, value, scan.fileClassifications[key as keyof FileClassificationCounts], failures);
  }
}

function compareGraph(
  expected: Partial<Record<SmokeMetricName, number>>,
  actual: Partial<Record<SmokeMetricName, number>>,
  failures: string[],
): void {
  for (const [key, value] of Object.entries(expected)) {
    compareValue(`graph.${key}`, value, actual[key as SmokeMetricName], failures);
  }
}

function compareValue(label: string, expected: unknown, actual: unknown, failures: string[]): void {
  if (expected !== actual) {
    failures.push(`${label}: expected ${String(expected)}, got ${String(actual)}`);
  }
}

function elapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function selectSamples(samples: SmokeSample[], suite: string): SmokeSample[] {
  if (suite === "all") return samples;
  if (suite === "standing" || suite === "internet") {
    return samples.filter((sample) => sample.suite === suite);
  }
  throw new Error(`Unsupported smoke suite: ${suite}`);
}

function printSmokeReport(report: SmokeReport): void {
  console.log("Smoke validation");
  console.log(`  Status: ${report.status}`);
  for (const result of report.results) {
    console.log(`  - ${result.name}: ${result.status}`);
    if (result.incrementalBenchmark) {
      const benchmark = result.incrementalBenchmark;
      console.log(
        `      incremental: ${benchmark.status}; full scan ${benchmark.fullScanMs}ms, cold cache ${benchmark.coldCacheScanMs}ms, warm cache ${benchmark.warmCacheScanMs}ms (${benchmark.parseCache.hits} reused)`,
      );
    }
    for (const failure of result.failures) {
      console.log(`      ${failure}`);
    }
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function resolvePath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) return path.join(os.homedir(), input.slice(2));
  return path.resolve(input);
}

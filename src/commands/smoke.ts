import { access, mkdir, writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import os from "node:os";
import path from "node:path";
import { KuzuGraphWriter } from "../adapters/kuzu/index.js";
import { SCHEMA_VERSION } from "../graph/schema.js";
import { scanOrchestrator } from "../core/adapters/index.js";
import type { FileClassificationCounts } from "../scanner/file-classification.js";
import type { ScanReport, ScanStatus } from "../scanner/report.js";

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

export type IncrementalBenchmarkResult = {
  status: "passed" | "failed";
  fullScanMs: number;
  fullWriteMs: number;
  incrementalScanMs: number;
  incrementalWriteMs: number;
  incremental: ScanReport["incremental"];
  parsePlan: ScanReport["parsePlan"];
  graphPatch: ScanReport["graphPatch"];
  failures: string[];
};

const defaultSamples: SmokeSample[] = [
  {
    name: "express",
    suite: "standing",
    projectPath: "~/Desktop/concentrate-sample-express",
    databasePath: ".concentrate/express.kuzu",
    expected: {
      discoveredFiles: 213,
      supportedFiles: 141,
      parsedFiles: 141,
      failedFiles: 0,
      resolvedImports: 158,
      unresolvedRelativeImports: 0,
      nodes: 3281,
      relationships: 4130,
      fileClassifications: { production: 50, test: 91, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
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
    projectPath: "~/Desktop/concentrate-sample-fastify",
    databasePath: ".concentrate/fastify.kuzu",
    expected: {
      discoveredFiles: 45,
      supportedFiles: 18,
      parsedFiles: 18,
      failedFiles: 0,
      resolvedImports: 10,
      unresolvedRelativeImports: 1,
      nodes: 339,
      relationships: 392,
      fileClassifications: { production: 11, test: 7, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
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
    projectPath: "~/Desktop/concentrate-sample-nestjs",
    databasePath: ".concentrate/nestjs.kuzu",
    expected: {
      discoveredFiles: 16,
      supportedFiles: 7,
      parsedFiles: 7,
      failedFiles: 0,
      resolvedImports: 7,
      unresolvedRelativeImports: 13,
      nodes: 68,
      relationships: 95,
      fileClassifications: { production: 5, test: 2, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
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
    projectPath: "~/Desktop/concentrate-sample-ky",
    databasePath: ".concentrate/ky.kuzu",
    expected: {
      discoveredFiles: 68,
      supportedFiles: 52,
      parsedFiles: 52,
      failedFiles: 0,
      resolvedImports: 134,
      unresolvedRelativeImports: 0,
      nodes: 5494,
      relationships: 6926,
      fileClassifications: { production: 29, test: 23, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
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
    projectPath: ".concentrate/internet-samples/node-express-firebase-mongodb",
    databasePath: ".concentrate/internet-node-express-firebase-mongodb.kuzu",
    expected: {
      discoveredFiles: 40,
      supportedFiles: 24,
      parsedFiles: 24,
      failedFiles: 0,
      resolvedImports: 22,
      unresolvedRelativeImports: 28,
      nodes: 438,
      relationships: 536,
      fileClassifications: { production: 20, test: 3, fixture: 0, support: 0, generated: 1 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
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
    projectPath: ".concentrate/internet-samples/node-express-realworld-example-app",
    databasePath: ".concentrate/internet-node-express-realworld.kuzu",
    expected: {
      discoveredFiles: 67,
      supportedFiles: 39,
      parsedFiles: 39,
      failedFiles: 0,
      resolvedImports: 49,
      unresolvedRelativeImports: 22,
      nodes: 540,
      relationships: 862,
      fileClassifications: { production: 29, test: 7, fixture: 0, support: 3, generated: 0 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
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
    projectPath: ".concentrate/internet-samples/nest",
    databasePath: ".concentrate/internet-nest.kuzu",
    continueOnError: true,
    expected: {
      status: "partial",
      discoveredFiles: 2115,
      supportedFiles: 1714,
      parsedFiles: 1712,
      failedFiles: 2,
      resolvedImports: 4914,
      unresolvedRelativeImports: 1395,
      nodes: 27392,
      relationships: 42953,
      fileClassifications: { production: 985, test: 351, fixture: 376, support: 0, generated: 0 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
        routes: 309,
        entrypoints: 3,
        envVars: 9,
        configValues: 144,
        dataModels: 4,
      },
    },
  },
];

export async function smokeCommand(options: SmokeOptions): Promise<void> {
  const samples = selectSamples(defaultSamples, options.suite);
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

  const writer = await KuzuGraphWriter.open(databasePath);
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
    ? await runIncrementalBenchmark(sample, projectPath, databasePath, graph.manifest, graphMetrics, fullScanMs, fullWriteMs)
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
  databasePath: string,
  previousManifest: unknown,
  expectedGraphMetrics: Partial<Record<SmokeMetricName, number>>,
  fullScanMs: number,
  fullWriteMs: number,
): Promise<IncrementalBenchmarkResult> {
  const failures: string[] = [];
  const previousManifestPath = `${databasePath}.previous-manifest.json`;
  await writeFile(previousManifestPath, `${JSON.stringify(previousManifest, null, 2)}\n`, "utf8");

  const incrementalScanStartedAt = performance.now();
  const incrementalGraph = await scanOrchestrator.buildGraph(projectPath, {
    continueOnError: sample.continueOnError ?? false,
    exclude: sample.exclude,
    previousManifestPath,
    incrementalMode: "changed-files",
  });
  const incrementalScanMs = elapsedMs(incrementalScanStartedAt);

  const writer = await KuzuGraphWriter.open(databasePath);
  const incrementalWriteStartedAt = performance.now();
  try {
    if (await writer.schemaVersion() === SCHEMA_VERSION && incrementalGraph.report.incremental.compatible) {
      const affectedFiles = [
        ...incrementalGraph.report.parsePlan.addedFiles,
        ...incrementalGraph.report.parsePlan.changedFiles,
        ...incrementalGraph.report.parsePlan.deletedFiles,
      ];
      const patch = await writer.patch(incrementalGraph.nodes, incrementalGraph.relationships, { affectedFiles });
      incrementalGraph.report.graphPatch = {
        requested: true,
        effectiveMode: "patch",
        reason: null,
        affectedFiles: patch.affectedFiles,
        nodesWritten: patch.nodesWritten,
        relationshipsWritten: patch.relationshipsWritten,
      };
    } else {
      incrementalGraph.report.graphPatch = {
        ...incrementalGraph.report.graphPatch,
        requested: true,
        effectiveMode: "reset",
        reason: incrementalGraph.report.incremental.reason ?? "Previous graph is not compatible",
      };
      await writer.reset();
      await writer.write(incrementalGraph.nodes, incrementalGraph.relationships);
    }
  } finally {
    await writer.close();
  }
  const incrementalWriteMs = elapsedMs(incrementalWriteStartedAt);

  const actualGraphMetrics = await readGraphMetrics(databasePath, expectedGraphMetrics);
  compareGraph(expectedGraphMetrics, actualGraphMetrics, failures);
  if (!incrementalGraph.report.incremental.compatible) {
    failures.push(incrementalGraph.report.incremental.reason ?? "incremental comparison was not compatible");
  }
  if (incrementalGraph.report.graphPatch.effectiveMode !== "patch") {
    failures.push(`graphPatch.effectiveMode: expected patch, got ${incrementalGraph.report.graphPatch.effectiveMode}`);
  }

  return {
    status: failures.length === 0 ? "passed" : "failed",
    fullScanMs,
    fullWriteMs,
    incrementalScanMs,
    incrementalWriteMs,
    incremental: incrementalGraph.report.incremental,
    parsePlan: incrementalGraph.report.parsePlan,
    graphPatch: incrementalGraph.report.graphPatch,
    failures,
  };
}

async function readSemanticSamples(databasePath: string, limit: number): Promise<SemanticSamples> {
  const writer = await KuzuGraphWriter.open(databasePath);
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

async function readRouteSamples(writer: KuzuGraphWriter, limit: number): Promise<SemanticRouteSample[]> {
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

async function readEntrypointSamples(writer: KuzuGraphWriter, limit: number): Promise<SemanticEntrypointSample[]> {
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

async function readEnvConfigSamples(writer: KuzuGraphWriter, limit: number): Promise<SemanticEnvConfigSample[]> {
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

async function readDataAccessSamples(writer: KuzuGraphWriter, limit: number): Promise<SemanticDataAccessSample[]> {
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
  const writer = await KuzuGraphWriter.open(databasePath);
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

async function queryCount(writer: KuzuGraphWriter, cypher: string): Promise<number> {
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
        `      incremental: ${benchmark.status}; full scan/write ${benchmark.fullScanMs}ms/${benchmark.fullWriteMs}ms, incremental scan/write ${benchmark.incrementalScanMs}ms/${benchmark.incrementalWriteMs}ms`,
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

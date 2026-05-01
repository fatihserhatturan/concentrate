import { access, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { KuzuGraphWriter } from "../graph/kuzu-writer.js";
import { SCHEMA_VERSION } from "../graph/schema.js";
import { buildCodeGraph } from "../scanner/build-code-graph.js";
import type { FileClassificationCounts } from "../scanner/file-classification.js";
import type { ScanReport, ScanStatus } from "../scanner/report.js";

export type SmokeSuite = "standing" | "internet";

type SmokeOptions = {
  suite: string;
  report: string;
  allowMissing: boolean;
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
  failures: string[];
};

export type SmokeReport = {
  status: "passed" | "failed";
  generatedAt: string;
  results: SmokeSampleResult[];
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
      nodes: 3277,
      relationships: 3827,
      fileClassifications: { production: 50, test: 91, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
        routes: 91,
        routesWithFullPath: 57,
        routeHandledBy: 65,
        routeLifecycleStep: 65,
        lifecyclePrecedes: 9,
        envVars: 2,
        configValues: 2,
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
      nodes: 64,
      relationships: 77,
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
        configValues: 6,
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
      nodes: 5490,
      relationships: 6736,
      fileClassifications: { production: 29, test: 23, fixture: 0, support: 0, generated: 0 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
        routes: 0,
        routesWithFullPath: 0,
        envVars: 2,
        configValues: 7,
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
      nodes: 433,
      relationships: 484,
      fileClassifications: { production: 20, test: 3, fixture: 0, support: 0, generated: 1 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
        routes: 7,
        envVars: 2,
        configValues: 10,
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
      nodes: 536,
      relationships: 710,
      fileClassifications: { production: 29, test: 7, fixture: 0, support: 3, generated: 0 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
        routes: 26,
        envVars: 4,
        configValues: 6,
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
      resolvedImports: 3770,
      unresolvedRelativeImports: 2539,
      nodes: 27348,
      relationships: 35045,
      fileClassifications: { production: 985, test: 351, fixture: 376, support: 0, generated: 0 },
      graph: {
        schemaVersion: SCHEMA_VERSION,
        routes: 309,
        entrypoints: 3,
        envVars: 9,
        configValues: 114,
        dataModels: 0,
      },
    },
  },
];

export async function smokeCommand(options: SmokeOptions): Promise<void> {
  const samples = selectSamples(defaultSamples, options.suite);
  const report = await runSmokeValidation(samples, {
    allowMissing: options.allowMissing,
    reportPath: options.report,
  });

  printSmokeReport(report);
  if (report.status === "failed") {
    process.exitCode = 1;
  }
}

export async function runSmokeValidation(
  samples: SmokeSample[],
  options: { allowMissing: boolean; reportPath: string },
): Promise<SmokeReport> {
  const results: SmokeSampleResult[] = [];

  for (const sample of samples) {
    results.push(await runSmokeSample(sample, options.allowMissing));
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

async function runSmokeSample(sample: SmokeSample, allowMissing: boolean): Promise<SmokeSampleResult> {
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

  const graph = await buildCodeGraph(projectPath, {
    continueOnError: sample.continueOnError ?? false,
    exclude: sample.exclude,
  });

  const writer = await KuzuGraphWriter.open(databasePath);
  try {
    await writer.reset();
    await writer.write(graph.nodes, graph.relationships);
  } finally {
    await writer.close();
  }

  const graphMetrics = await readGraphMetrics(databasePath, sample.expected.graph);
  compareScan(sample.expected, graph.report, graph.nodes.length, graph.relationships.length, failures);
  compareGraph(sample.expected.graph, graphMetrics, failures);

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
    failures,
  };
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

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
  apiOrigins?: string[];
  expected: SmokeExpected;
};

export type SmokeExpected = {
  status?: ScanStatus;
  discoveredFiles: number;
  supportedFiles: number;
  otherFiles: number;
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
  | "dataModels"
  | "requests";

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
  // One repository at the sample root, or `parts`: several repositories,
  // each checked out into its own directory of the sample.
  repo?: string;
  sha?: string;
  parts?: Array<{ dir: string; repo: string; sha: string }>;
  continueOnError?: boolean;
  exclude?: string[];
  // Scan setting: origins that serve the sample's own routes.
  apiOrigins?: string[];
  // An internet sample small enough to keep a golden graph of
  // (tests/golden/samples/); standing samples always have one.
  golden?: boolean;
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
      apiOrigins: entry.apiOrigins,
    };
  });
}

export const defaultSampleExpectations: SampleExpectation[] = [
  {
    name: "express",
    suite: "standing",
    expected: {
      discoveredFiles: 213,
      supportedFiles: 149,
      otherFiles: 64,
      parsedFiles: 149,
      failedFiles: 0,
      resolvedImports: 158,
      unresolvedRelativeImports: 0,
      nodes: 13175,
      relationships: 15240,
      fileClassifications: { production: 92, test: 91, fixture: 21, support: 0, generated: 0, docs: 9 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 110,
        routesWithFullPath: 68,
        routeHandledBy: 84,
        routeLifecycleStep: 84,
        lifecyclePrecedes: 9,
        envVars: 2,
        configValues: 5,
        entrypoints: 14,
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
      otherFiles: 27,
      parsedFiles: 18,
      failedFiles: 0,
      resolvedImports: 10,
      unresolvedRelativeImports: 1,
      nodes: 480,
      relationships: 581,
      fileClassifications: { production: 25, test: 8, fixture: 0, support: 0, generated: 0, docs: 12 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 14,
        routesWithFullPath: 14,
        routeHandledBy: 14,
        routeLifecycleStep: 12,
        lifecyclePrecedes: 0,
        envVars: 5,
        configValues: 0,
        entrypoints: 22,
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
      otherFiles: 9,
      parsedFiles: 7,
      failedFiles: 0,
      resolvedImports: 7,
      unresolvedRelativeImports: 0,
      nodes: 107,
      relationships: 144,
      fileClassifications: { production: 11, test: 3, fixture: 0, support: 0, generated: 1, docs: 1 },
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
        entrypoints: 12,
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
      otherFiles: 15,
      parsedFiles: 52,
      failedFiles: 0,
      resolvedImports: 134,
      unresolvedRelativeImports: 0,
      nodes: 7372,
      relationships: 9320,
      fileClassifications: { production: 41, test: 23, fixture: 0, support: 0, generated: 0, docs: 3 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 0,
        routesWithFullPath: 0,
        envVars: 2,
        configValues: 10,
        entrypoints: 7,
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
      otherFiles: 16,
      parsedFiles: 24,
      failedFiles: 0,
      resolvedImports: 22,
      unresolvedRelativeImports: 0,
      nodes: 558,
      relationships: 734,
      fileClassifications: { production: 35, test: 3, fixture: 0, support: 0, generated: 1, docs: 1 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 7,
        envVars: 5,
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
      otherFiles: 28,
      parsedFiles: 39,
      failedFiles: 0,
      resolvedImports: 49,
      unresolvedRelativeImports: 0,
      nodes: 741,
      relationships: 1326,
      fileClassifications: { production: 55, test: 7, fixture: 0, support: 3, generated: 1, docs: 1 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 26,
        envVars: 5,
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
      otherFiles: 397,
      parsedFiles: 1718,
      failedFiles: 0,
      resolvedImports: 4925,
      unresolvedRelativeImports: 0,
      nodes: 54139,
      relationships: 73486,
      fileClassifications: { production: 1085, test: 364, fixture: 644, support: 0, generated: 2, docs: 20 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 309,
        entrypoints: 573,
        envVars: 23,
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
      otherFiles: 6,
      parsedFiles: 39,
      failedFiles: 0,
      resolvedImports: 82,
      unresolvedRelativeImports: 0,
      nodes: 780,
      relationships: 1172,
      fileClassifications: { production: 43, test: 0, fixture: 0, support: 0, generated: 0, docs: 2 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 0,
      },
    },
  },
  {
    name: "internet-vue-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 125,
      supportedFiles: 93,
      otherFiles: 32,
      parsedFiles: 93,
      failedFiles: 0,
      resolvedImports: 198,
      unresolvedRelativeImports: 0,
      nodes: 2623,
      relationships: 4240,
      fileClassifications: { production: 79, test: 33, fixture: 7, support: 1, generated: 1, docs: 4 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 0,
        entrypoints: 37,
      },
    },
  },
  {
    name: "internet-sveltekit-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 62,
      supportedFiles: 43,
      otherFiles: 19,
      parsedFiles: 43,
      failedFiles: 0,
      resolvedImports: 35,
      unresolvedRelativeImports: 1,
      nodes: 791,
      relationships: 1719,
      fileClassifications: { production: 57, test: 0, fixture: 0, support: 0, generated: 1, docs: 4 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 11,
        entrypoints: 7,
      },
    },
  },
  {
    name: "internet-angular-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 107,
      supportedFiles: 80,
      otherFiles: 27,
      parsedFiles: 80,
      failedFiles: 0,
      resolvedImports: 143,
      unresolvedRelativeImports: 0,
      nodes: 4971,
      relationships: 5821,
      fileClassifications: { production: 81, test: 18, fixture: 0, support: 1, generated: 1, docs: 6 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 0,
        entrypoints: 34,
      },
    },
  },
  {
    name: "internet-go-gin-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 41,
      supportedFiles: 21,
      otherFiles: 20,
      parsedFiles: 21,
      failedFiles: 0,
      resolvedImports: 18,
      unresolvedRelativeImports: 0,
      nodes: 2708,
      relationships: 4790,
      fileClassifications: { production: 29, test: 4, fixture: 0, support: 0, generated: 1, docs: 7 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 31,
        entrypoints: 12,
      },
    },
  },
  {
    name: "internet-go-echo-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 35,
      supportedFiles: 24,
      otherFiles: 11,
      parsedFiles: 24,
      failedFiles: 0,
      resolvedImports: 34,
      unresolvedRelativeImports: 0,
      nodes: 1402,
      relationships: 3123,
      fileClassifications: { production: 27, test: 3, fixture: 0, support: 0, generated: 1, docs: 4 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 20,
      },
    },
  },
  {
    name: "internet-go-clean-arch",
    suite: "internet",
    expected: {
      discoveredFiles: 41,
      supportedFiles: 19,
      otherFiles: 22,
      parsedFiles: 19,
      failedFiles: 0,
      resolvedImports: 23,
      unresolvedRelativeImports: 0,
      nodes: 967,
      relationships: 1316,
      fileClassifications: { production: 28, test: 5, fixture: 0, support: 0, generated: 4, docs: 4 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 4,
        entrypoints: 26,
      },
    },
  },
  {
    name: "internet-go-chi-base",
    suite: "internet",
    expected: {
      discoveredFiles: 69,
      supportedFiles: 47,
      otherFiles: 22,
      parsedFiles: 47,
      failedFiles: 0,
      resolvedImports: 44,
      unresolvedRelativeImports: 0,
      nodes: 1626,
      relationships: 2411,
      fileClassifications: { production: 64, test: 1, fixture: 0, support: 0, generated: 1, docs: 3 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 19,
        entrypoints: 26,
      },
    },
  },
  {
    name: "internet-go-simplebank",
    suite: "internet",
    expected: {
      discoveredFiles: 153,
      supportedFiles: 90,
      otherFiles: 63,
      parsedFiles: 90,
      failedFiles: 0,
      resolvedImports: 111,
      unresolvedRelativeImports: 1,
      nodes: 3682,
      relationships: 5411,
      fileClassifications: { production: 111, test: 18, fixture: 0, support: 0, generated: 21, docs: 3 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 9,
        entrypoints: 49,
      },
    },
  },
  {
    name: "internet-go-kratos-beer-shop",
    suite: "internet",
    expected: {
      discoveredFiles: 473,
      supportedFiles: 283,
      otherFiles: 190,
      parsedFiles: 283,
      failedFiles: 0,
      resolvedImports: 379,
      unresolvedRelativeImports: 0,
      nodes: 17215,
      relationships: 20427,
      fileClassifications: { production: 295, test: 2, fixture: 0, support: 2, generated: 113, docs: 61 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 27,
        entrypoints: 155,
      },
    },
  },
  {
    name: "internet-c-cjson",
    suite: "internet",
    expected: {
      discoveredFiles: 161,
      supportedFiles: 55,
      otherFiles: 106,
      parsedFiles: 55,
      failedFiles: 0,
      resolvedImports: 90,
      unresolvedRelativeImports: 1,
      nodes: 4888,
      relationships: 7785,
      fileClassifications: { production: 43, test: 105, fixture: 7, support: 0, generated: 0, docs: 6 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        entrypoints: 77,
      },
    },
  },
  {
    name: "internet-cpp-tinyxml2",
    suite: "internet",
    expected: {
      discoveredFiles: 272,
      supportedFiles: 191,
      otherFiles: 81,
      parsedFiles: 191,
      failedFiles: 0,
      resolvedImports: 995,
      unresolvedRelativeImports: 10,
      nodes: 8597,
      relationships: 28651,
      fileClassifications: { production: 208, test: 1, fixture: 0, support: 0, generated: 0, docs: 63 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        entrypoints: 309,
      },
    },
  },
  {
    name: "internet-cpp-crow-examples",
    suite: "internet",
    expected: {
      discoveredFiles: 38,
      supportedFiles: 20,
      otherFiles: 18,
      parsedFiles: 20,
      failedFiles: 0,
      resolvedImports: 0,
      unresolvedRelativeImports: 21,
      nodes: 589,
      relationships: 665,
      fileClassifications: { production: 36, test: 0, fixture: 0, support: 0, generated: 0, docs: 2 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 59,
        routesWithFullPath: 59,
        entrypoints: 35,
      },
    },
  },
  {
    name: "internet-cpp-drogon-examples",
    suite: "internet",
    expected: {
      discoveredFiles: 86,
      supportedFiles: 42,
      otherFiles: 44,
      parsedFiles: 42,
      failedFiles: 0,
      resolvedImports: 15,
      unresolvedRelativeImports: 1,
      nodes: 1131,
      relationships: 1311,
      fileClassifications: { production: 69, test: 4, fixture: 0, support: 0, generated: 0, docs: 13 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 38,
        routesWithFullPath: 38,
        routeHandledBy: 23,
        entrypoints: 38,
      },
    },
  },
  {
    name: "internet-cpp-httplib-examples",
    suite: "internet",
    expected: {
      discoveredFiles: 36,
      supportedFiles: 17,
      otherFiles: 19,
      parsedFiles: 17,
      failedFiles: 0,
      resolvedImports: 0,
      unresolvedRelativeImports: 1,
      nodes: 553,
      relationships: 638,
      fileClassifications: { production: 30, test: 0, fixture: 0, support: 0, generated: 0, docs: 6 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 20,
        routesWithFullPath: 20,
        entrypoints: 39,
      },
    },
  },
  {
    name: "internet-cpp-sqlitecpp-examples",
    suite: "internet",
    expected: {
      discoveredFiles: 33,
      supportedFiles: 3,
      otherFiles: 30,
      parsedFiles: 3,
      failedFiles: 0,
      resolvedImports: 0,
      unresolvedRelativeImports: 0,
      nodes: 1370,
      relationships: 1794,
      fileClassifications: { production: 26, test: 0, fixture: 0, support: 0, generated: 0, docs: 7 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        entrypoints: 8,
        dataModels: 1,
      },
    },
  },
  {
    name: "internet-cpp-grpc-examples",
    suite: "internet",
    expected: {
      discoveredFiles: 113,
      supportedFiles: 18,
      otherFiles: 95,
      parsedFiles: 18,
      failedFiles: 0,
      resolvedImports: 4,
      unresolvedRelativeImports: 68,
      nodes: 1216,
      relationships: 1614,
      fileClassifications: { production: 91, test: 0, fixture: 0, support: 0, generated: 0, docs: 22 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        entrypoints: 85,
        envVars: 8,
      },
    },
  },
  {
    name: "internet-cpp-qt-network-examples",
    suite: "internet",
    expected: {
      discoveredFiles: 327,
      supportedFiles: 152,
      otherFiles: 175,
      parsedFiles: 152,
      failedFiles: 0,
      resolvedImports: 153,
      unresolvedRelativeImports: 11,
      nodes: 6971,
      relationships: 8624,
      fileClassifications: { production: 266, test: 0, fixture: 0, support: 0, generated: 0, docs: 61 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        entrypoints: 27,
        dataModels: 11,
      },
    },
  },
  {
    name: "internet-c-curl-examples",
    suite: "internet",
    expected: {
      discoveredFiles: 223,
      supportedFiles: 130,
      otherFiles: 93,
      parsedFiles: 130,
      failedFiles: 0,
      resolvedImports: 0,
      unresolvedRelativeImports: 0,
      nodes: 4186,
      relationships: 4447,
      fileClassifications: { production: 149, test: 0, fixture: 0, support: 0, generated: 0, docs: 74 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        entrypoints: 131,
        envVars: 12,
      },
    },
  },
  {
    name: "internet-cpp-googletest",
    suite: "internet",
    expected: {
      status: "partial",
      discoveredFiles: 247,
      supportedFiles: 186,
      otherFiles: 61,
      parsedFiles: 183,
      failedFiles: 3,
      resolvedImports: 362,
      unresolvedRelativeImports: 40,
      nodes: 27799,
      relationships: 39874,
      fileClassifications: { production: 77, test: 116, fixture: 18, support: 0, generated: 0, docs: 33 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        entrypoints: 138,
      },
    },
  },
  {
    name: "internet-rust-axum-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 24,
      supportedFiles: 12,
      otherFiles: 12,
      parsedFiles: 12,
      failedFiles: 0,
      resolvedImports: 50,
      unresolvedRelativeImports: 0,
      nodes: 653,
      relationships: 997,
      fileClassifications: { production: 20, test: 0, fixture: 0, support: 0, generated: 1, docs: 3 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 19,
        entrypoints: 3,
      },
    },
  },
  {
    name: "internet-rust-actix-diesel-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 96,
      supportedFiles: 65,
      otherFiles: 31,
      parsedFiles: 65,
      failedFiles: 0,
      resolvedImports: 264,
      unresolvedRelativeImports: 0,
      nodes: 1972,
      relationships: 2912,
      fileClassifications: { production: 93, test: 0, fixture: 0, support: 0, generated: 1, docs: 2 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 20,
      },
    },
  },
  {
    name: "internet-realworld-rust-fullstack",
    suite: "internet",
    expected: {
      discoveredFiles: 122,
      supportedFiles: 74,
      otherFiles: 48,
      parsedFiles: 74,
      failedFiles: 0,
      resolvedImports: 182,
      unresolvedRelativeImports: 0,
      nodes: 1633,
      relationships: 2346,
      fileClassifications: { production: 116, test: 0, fixture: 0, support: 0, generated: 2, docs: 4 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 19,
        requests: 33,
      },
    },
  },
  {
    name: "internet-realworld-python-django-fullstack",
    suite: "internet",
    expected: {
      discoveredFiles: 146,
      supportedFiles: 106,
      otherFiles: 40,
      parsedFiles: 106,
      failedFiles: 0,
      resolvedImports: 180,
      unresolvedRelativeImports: 0,
      nodes: 1593,
      relationships: 2141,
      fileClassifications: { production: 142, test: 0, fixture: 0, support: 0, generated: 1, docs: 3 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 19,
        requests: 32,
      },
    },
  },
  {
    name: "internet-realworld-python-flask-fullstack",
    suite: "internet",
    expected: {
      discoveredFiles: 142,
      supportedFiles: 92,
      otherFiles: 50,
      parsedFiles: 92,
      failedFiles: 0,
      resolvedImports: 209,
      unresolvedRelativeImports: 0,
      nodes: 2062,
      relationships: 2842,
      fileClassifications: { production: 126, test: 8, fixture: 0, support: 0, generated: 2, docs: 6 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 19,
        requests: 33,
      },
    },
  },
  {
    name: "internet-realworld-python-fastapi-fullstack",
    suite: "internet",
    expected: {
      discoveredFiles: 223,
      supportedFiles: 157,
      otherFiles: 66,
      parsedFiles: 157,
      failedFiles: 0,
      resolvedImports: 382,
      unresolvedRelativeImports: 0,
      nodes: 2970,
      relationships: 4433,
      fileClassifications: { production: 194, test: 24, fixture: 0, support: 0, generated: 2, docs: 3 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 19,
        requests: 33,
      },
    },
  },
  {
    name: "internet-python-django-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 48,
      supportedFiles: 44,
      otherFiles: 4,
      parsedFiles: 44,
      failedFiles: 0,
      resolvedImports: 48,
      unresolvedRelativeImports: 0,
      nodes: 613,
      relationships: 793,
      fileClassifications: { production: 46, test: 0, fixture: 0, support: 0, generated: 0, docs: 2 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 19,
        routesWithFullPath: 19,
        entrypoints: 1,
      },
    },
  },
  {
    name: "internet-python-flask-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 44,
      supportedFiles: 30,
      otherFiles: 14,
      parsedFiles: 30,
      failedFiles: 0,
      resolvedImports: 77,
      unresolvedRelativeImports: 0,
      nodes: 1082,
      relationships: 1493,
      fileClassifications: { production: 30, test: 8, fixture: 0, support: 0, generated: 1, docs: 5 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 19,
        routesWithFullPath: 19,
        entrypoints: 4,
      },
    },
  },
  {
    name: "internet-python-fastapi-realworld",
    suite: "internet",
    expected: {
      discoveredFiles: 125,
      supportedFiles: 95,
      otherFiles: 30,
      parsedFiles: 95,
      failedFiles: 0,
      resolvedImports: 250,
      unresolvedRelativeImports: 0,
      nodes: 1990,
      relationships: 3085,
      fileClassifications: { production: 98, test: 24, fixture: 0, support: 0, generated: 1, docs: 2 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 19,
        routesWithFullPath: 19,
        entrypoints: 8,
      },
    },
  },
  {
    name: "internet-python-fastapi-template",
    suite: "internet",
    expected: {
      discoveredFiles: 113,
      supportedFiles: 47,
      otherFiles: 66,
      parsedFiles: 47,
      failedFiles: 0,
      resolvedImports: 137,
      unresolvedRelativeImports: 0,
      nodes: 1724,
      relationships: 3167,
      fileClassifications: { production: 85, test: 17, fixture: 0, support: 0, generated: 2, docs: 9 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 23,
        routesWithFullPath: 23,
        entrypoints: 47,
      },
    },
  },
  {
    name: "internet-go-remark42",
    suite: "internet",
    expected: {
      discoveredFiles: 256,
      supportedFiles: 158,
      otherFiles: 98,
      parsedFiles: 158,
      failedFiles: 0,
      resolvedImports: 153,
      unresolvedRelativeImports: 0,
      nodes: 22152,
      relationships: 28212,
      fileClassifications: { production: 123, test: 85, fixture: 24, support: 0, generated: 6, docs: 18 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 65,
        entrypoints: 79,
      },
    },
  },
  {
    name: "internet-remark42-frontend",
    suite: "internet",
    expected: {
      discoveredFiles: 426,
      supportedFiles: 273,
      otherFiles: 153,
      parsedFiles: 273,
      failedFiles: 0,
      resolvedImports: 307,
      unresolvedRelativeImports: 4,
      nodes: 13000,
      relationships: 16967,
      fileClassifications: { production: 308, test: 87, fixture: 0, support: 11, generated: 2, docs: 18 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 0,
        routesWithFullPath: 0,
        routeHandledBy: 0,
        entrypoints: 0,
        envVars: 0,
        dataModels: 0,
        requests: 0,
      },
    },
  },
  {
    name: "internet-nextjs-taxonomy",
    suite: "internet",
    expected: {
      discoveredFiles: 188,
      supportedFiles: 131,
      otherFiles: 57,
      parsedFiles: 131,
      failedFiles: 0,
      resolvedImports: 267,
      unresolvedRelativeImports: 11,
      nodes: 2413,
      relationships: 4063,
      fileClassifications: { production: 170, test: 0, fixture: 0, support: 0, generated: 1, docs: 17 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 9,
        entrypoints: 8,
      },
    },
  },
  {
    name: "internet-realworld-fullstack",
    suite: "internet",
    expected: {
      status: "success",
      discoveredFiles: 165,
      supportedFiles: 101,
      otherFiles: 64,
      parsedFiles: 101,
      failedFiles: 0,
      resolvedImports: 181,
      unresolvedRelativeImports: 0,
      nodes: 1711,
      relationships: 2549,
      fileClassifications: { production: 151, test: 7, fixture: 0, support: 3, generated: 2, docs: 2 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 26,
        requests: 34,
      },
    },
  },
  {
    name: "internet-realworld-go-fullstack",
    suite: "internet",
    expected: {
      status: "success",
      discoveredFiles: 139,
      supportedFiles: 83,
      otherFiles: 56,
      parsedFiles: 83,
      failedFiles: 0,
      resolvedImports: 150,
      unresolvedRelativeImports: 0,
      nodes: 3688,
      relationships: 6134,
      fileClassifications: { production: 125, test: 4, fixture: 0, support: 0, generated: 2, docs: 8 },
      graph: {
        schemaVersion: GRAPH_SCHEMA_VERSION,
        routes: 31,
        requests: 83,
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
    apiOrigins: sample.apiOrigins,
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
    apiOrigins: sample.apiOrigins,
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
    if ("requests" in expected) metrics.requests = await queryCount(writer, "MATCH ()-[r:REQUESTS]->() RETURN count(r) AS count");
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
  compareValue("otherFiles", expected.otherFiles, scan.otherFiles, failures);
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

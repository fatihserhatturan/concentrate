import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { KuzuGraphWriter, type KuzuWriteMode } from "../adapters/kuzu/index.js";
import { SCHEMA_VERSION } from "../graph/schema.js";
import { printScanReport } from "../cli/report.js";
import { ProgressReporter } from "../cli/progress.js";
import { scanOrchestrator } from "../core/adapters/index.js";
import type { BuildCodeGraphResult } from "../scanner/build-code-graph-types.js";
import type { IncrementalMode } from "../scanner/parse-plan.js";
import { didFailFast, didPartiallySucceed } from "../scanner/report.js";
import type { IncrementalEligibility } from "../scanner/scan-manifest.js";

type ScanOptions = {
  database: string;
  continueOnError: boolean;
  concurrency?: number;
  maxFiles?: number;
  include: string[];
  exclude: string[];
  kuzuWriteMode: string;
  manifest: string;
  previousManifest?: string;
  incremental: string;
};

export async function scanCommand(projectPath: string, options: ScanOptions): Promise<void> {
  const databasePath = path.resolve(options.database);
  const manifestPath = path.resolve(options.manifest);
  const incrementalMode = parseIncrementalMode(options.incremental);
  const kuzuWriteMode = parseKuzuWriteMode(options.kuzuWriteMode);
  const progress = new ProgressReporter();

  const result = await scanOrchestrator.buildGraph(projectPath, {
    continueOnError: options.continueOnError,
    concurrency: options.concurrency,
    maxFiles: options.maxFiles,
    include: options.include.length > 0 ? options.include : undefined,
    exclude: options.exclude.length > 0 ? options.exclude : undefined,
    previousManifestPath: options.previousManifest ? path.resolve(options.previousManifest) : undefined,
    incrementalMode,
    onProgress: (current, total, relativePath) => {
      progress.update(current, total, relativePath);
    },
  });

  progress.clear();

  if (didFailFast(result)) {
    await writeManifest(manifestPath, result.manifest);
    printScanReport(result.report, result.nodes.length, result.relationships.length, databasePath);
    console.log(`  Manifest:        ${manifestPath}`);
    process.exitCode = 1;
    return;
  }

  const writer = await KuzuGraphWriter.open(databasePath);
  try {
    await writeGraph(writer, result, incrementalMode, kuzuWriteMode);
  } finally {
    await writer.close();
  }

  await writeManifest(manifestPath, result.manifest);
  printScanReport(result.report, result.nodes.length, result.relationships.length, databasePath);
  console.log(`  Manifest:        ${manifestPath}`);
  if (didPartiallySucceed(result)) {
    process.exitCode = 1;
  }
}

async function writeGraph(
  writer: KuzuGraphWriter,
  result: BuildCodeGraphResult,
  incrementalMode: IncrementalMode,
  kuzuWriteMode: KuzuWriteMode,
): Promise<void> {
  const requestedPatch = incrementalMode === "changed-files";
  result.report.graphPatch = {
    ...result.report.graphPatch,
    requested: requestedPatch,
  };

  if (!requestedPatch) {
    await resetAndWriteGraph(writer, result, kuzuWriteMode);
    return;
  }

  if (!result.report.incremental.compatible) {
    result.report.graphPatch = {
      ...result.report.graphPatch,
      effectiveMode: "reset",
      reason: result.report.incremental.reason ?? "Previous manifest is not compatible",
    };
    await resetAndWriteGraph(writer, result, kuzuWriteMode);
    return;
  }

  const schemaVersion = await writer.schemaVersion();
  if (schemaVersion !== SCHEMA_VERSION) {
    result.report.graphPatch = {
      ...result.report.graphPatch,
      effectiveMode: "reset",
      reason: schemaVersion === null
        ? "Previous graph schema is missing"
        : `Previous graph schema mismatch: previous ${schemaVersion}, current ${SCHEMA_VERSION}`,
    };
    await resetAndWriteGraph(writer, result, kuzuWriteMode);
    return;
  }

  const affectedFiles = affectedFilesFromManifestDiff(result.report.incremental);
  const patchSummary = await writer.patch(result.nodes, result.relationships, {
    affectedFiles,
    mode: kuzuWriteMode,
  });
  result.report.graphPatch = {
    requested: true,
    effectiveMode: "patch",
    reason: null,
    affectedFiles: patchSummary.affectedFiles,
    nodesWritten: patchSummary.nodesWritten,
    relationshipsWritten: patchSummary.relationshipsWritten,
  };
}

async function resetAndWriteGraph(
  writer: KuzuGraphWriter,
  result: BuildCodeGraphResult,
  kuzuWriteMode: KuzuWriteMode,
): Promise<void> {
  await writer.reset();
  await writer.write(result.nodes, result.relationships, {
    mode: kuzuWriteMode,
  });
  result.report.graphPatch = {
    ...result.report.graphPatch,
    nodesWritten: result.nodes.length,
    relationshipsWritten: result.relationships.length,
  };
}

function affectedFilesFromManifestDiff(incremental: IncrementalEligibility): string[] {
  const diff = incremental as IncrementalEligibility & {
    addedFiles?: string[];
    changedFiles?: string[];
    deletedFiles?: string[];
  };
  return [
    ...(diff.addedFiles ?? []),
    ...(diff.changedFiles ?? []),
    ...(diff.deletedFiles ?? []),
  ];
}

async function writeManifest(manifestPath: string, manifest: unknown): Promise<void> {
  await mkdir(path.dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function parseIncrementalMode(value: string): IncrementalMode {
  if (value === "full" || value === "changed-files") {
    return value;
  }

  throw new Error(`Unsupported incremental mode: ${value}`);
}

function parseKuzuWriteMode(value: string): KuzuWriteMode {
  if (value === "transaction" || value === "individual") {
    return value;
  }

  throw new Error(`Unsupported Kuzu write mode: ${value}`);
}

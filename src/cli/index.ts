#!/usr/bin/env node

import { Command } from "commander";
import { scanCommand } from "../commands/scan.js";
import { statsCommand } from "../commands/stats.js";
import { queryCommand } from "../commands/query.js";
import { exportCommand } from "../commands/export.js";
import { smokeCommand } from "../commands/smoke.js";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

const program = new Command();

program
  .name("concentrate")
  .description("Scan codebases into a queryable code graph.")
  .version("0.1.0");

program
  .command("scan")
  .description("Scan a project and write its graph into a Kuzu database.")
  .argument("<path>", "Project path to scan")
  .option("-d, --database <path>", "Kuzu database path", ".concentrate/graph.kuzu")
  .option("--continue-on-error", "Continue scanning when a supported file fails to parse", false)
  .option("--concurrency <n>", "Files to parse in parallel (default: CPU count)", parseInt)
  .option("--max-files <n>", "Maximum number of files to parse", parseInt)
  .option("--include <pattern>", "Include glob pattern, repeatable", collect, [] as string[])
  .option("--exclude <pattern>", "Exclude glob pattern, repeatable", collect, [] as string[])
  .option("--kuzu-write-mode <mode>", "Kuzu write mode: transaction or individual", "transaction")
  .action(scanCommand);

program
  .command("stats")
  .description("Show basic graph statistics.")
  .option("-d, --database <path>", "Kuzu database path", ".concentrate/graph.kuzu")
  .action(statsCommand);

program
  .command("query")
  .description("Run a Cypher query against the graph.")
  .argument("<cypher>", "Cypher query to execute")
  .option("-d, --database <path>", "Kuzu database path", ".concentrate/graph.kuzu")
  .option("-f, --format <format>", "Output format: json, table, csv", "json")
  .action(queryCommand);

program
  .command("export")
  .description("Scan a project and export its graph as JSONL files.")
  .argument("<path>", "Project path to scan")
  .option("-o, --output <path>", "Output directory", ".concentrate/export")
  .option("--continue-on-error", "Continue exporting when a supported file fails to parse", false)
  .option("--concurrency <n>", "Files to parse in parallel (default: CPU count)", parseInt)
  .option("--max-files <n>", "Maximum number of files to parse", parseInt)
  .option("--include <pattern>", "Include glob pattern, repeatable", collect, [] as string[])
  .option("--exclude <pattern>", "Exclude glob pattern, repeatable", collect, [] as string[])
  .action(exportCommand);

program
  .command("smoke")
  .description("Run sample repository smoke validation scans.")
  .option("--suite <suite>", "Smoke suite: standing, internet, or all", "all")
  .option("--report <path>", "Machine-readable smoke report path", ".concentrate/smoke-report.json")
  .option("--allow-missing", "Skip missing sample repositories instead of failing", false)
  .action(smokeCommand);

await program.parseAsync(process.argv);

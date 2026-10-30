import type { ProgramSpec } from "./adapters/cli/args.js";
import { scanCommand } from "./commands/scan.js";
import { statsCommand } from "./commands/stats.js";
import { queryCommand } from "./commands/query.js";
import { exportCommand } from "./commands/export.js";
import { smokeCommand } from "./commands/smoke.js";
import { mcpCommand } from "./commands/mcp.js";
import { watchCommand } from "./commands/watch.js";

/** Command-line surface of `concentrate`: every command, argument and flag. */
export const program: ProgramSpec = {
  name: "concentrate",
  description: "Scan codebases into a queryable code graph.",
  version: "0.1.0",
  commands: [
    {
      name: "scan",
      description: "Scan a project and write its graph into the graph store.",
      args: [{ name: "path", description: "Project path to scan" }],
      options: [
        { flags: "-d, --database <path>", description: "Graph store directory", default: ".concentrate/graph" },
        { flags: "--continue-on-error", description: "Continue scanning when a supported file fails to parse", type: "boolean" },
        { flags: "--concurrency <n>", description: "Files to parse in parallel (default: CPU count)", type: "number" },
        { flags: "--workers <n>", description: "Worker threads for parsing; 0 parses on the main thread (default: up to 4 once 100+ files need parsing)", type: "number" },
        { flags: "--max-files <n>", description: "Maximum number of files to parse", type: "number" },
        { flags: "--include <pattern>", description: "Include glob pattern, repeatable", multiple: true },
        { flags: "--exclude <pattern>", description: "Exclude glob pattern, repeatable", multiple: true },
        { flags: "--api-origin <url>", description: "Origin that serves this project's routes (https://api.example.com), repeatable: outbound calls to it link to the routes", multiple: true },
        { flags: "--no-retry-lock", description: "Fail at once if another scan is writing the store instead of waiting for it" },
        { flags: "--cache-dir <path>", description: "Parse cache directory; unchanged files are not parsed again", default: ".concentrate/cache" },
        { flags: "--no-cache", description: "Parse every file and leave the parse cache untouched" },
        { flags: "--manifest <path>", description: "Scan manifest (file hashes) output path", default: ".concentrate/scan-manifest.json" },
      ],
      action: scanCommand,
    },
    {
      name: "watch",
      description: "Scan a project, then rescan and rewrite the graph store whenever its files change.",
      args: [{ name: "path", description: "Project path to watch" }],
      options: [
        { flags: "-d, --database <path>", description: "Graph store directory", default: ".concentrate/graph" },
        { flags: "--continue-on-error", description: "Write a partial graph when a file fails to parse instead of keeping the last one", type: "boolean" },
        { flags: "--concurrency <n>", description: "Files to parse in parallel (default: CPU count)", type: "number" },
        { flags: "--workers <n>", description: "Worker threads for parsing; 0 parses on the main thread (default: up to 4 once 100+ files need parsing)", type: "number" },
        { flags: "--max-files <n>", description: "Maximum number of files to parse", type: "number" },
        { flags: "--include <pattern>", description: "Include glob pattern, repeatable", multiple: true },
        { flags: "--exclude <pattern>", description: "Exclude glob pattern, repeatable", multiple: true },
        { flags: "--api-origin <url>", description: "Origin that serves this project's routes (https://api.example.com), repeatable: outbound calls to it link to the routes", multiple: true },
        { flags: "--no-retry-lock", description: "Fail at once if another scan is writing the store instead of waiting for it" },
        { flags: "--cache-dir <path>", description: "Parse cache directory; unchanged files are not parsed again", default: ".concentrate/cache" },
        { flags: "--no-cache", description: "Parse every file on every rescan" },
        { flags: "--manifest <path>", description: "Scan manifest (file hashes) output path", default: ".concentrate/scan-manifest.json" },
        { flags: "--debounce <ms>", description: "Quiet period after the last change before rescanning", type: "number", default: 200 },
      ],
      action: watchCommand,
    },
    {
      name: "stats",
      description: "Show basic graph statistics.",
      options: [
        { flags: "-d, --database <path>", description: "Graph store directory", default: ".concentrate/graph" },
        { flags: "--package <name>", description: "Filter file-owned stats to one package name or relative path" },
      ],
      action: statsCommand,
    },
    {
      name: "query",
      description: "Run a Cypher query against the graph.",
      args: [{ name: "cypher", description: "Cypher query to execute" }],
      options: [
        { flags: "-d, --database <path>", description: "Graph store directory", default: ".concentrate/graph" },
        { flags: "-f, --format <format>", description: "Output format: json, table, csv", default: "json" },
        { flags: "-p, --param <name=value>", description: "Query parameter for $name, repeatable; JSON values are parsed", multiple: true },
      ],
      action: queryCommand,
    },
    {
      name: "export",
      description: "Scan a project and export its graph as JSONL files.",
      args: [{ name: "path", description: "Project path to scan" }],
      options: [
        { flags: "-o, --output <path>", description: "Output directory", default: ".concentrate/export" },
        { flags: "--continue-on-error", description: "Continue exporting when a supported file fails to parse", type: "boolean" },
        { flags: "--concurrency <n>", description: "Files to parse in parallel (default: CPU count)", type: "number" },
        { flags: "--workers <n>", description: "Worker threads for parsing; 0 parses on the main thread (default: up to 4 once 100+ files need parsing)", type: "number" },
        { flags: "--max-files <n>", description: "Maximum number of files to parse", type: "number" },
        { flags: "--include <pattern>", description: "Include glob pattern, repeatable", multiple: true },
        { flags: "--exclude <pattern>", description: "Exclude glob pattern, repeatable", multiple: true },
        { flags: "--api-origin <url>", description: "Origin that serves this project's routes (https://api.example.com), repeatable: outbound calls to it link to the routes", multiple: true },
        { flags: "--cache-dir <path>", description: "Parse cache directory; unchanged files are not parsed again", default: ".concentrate/cache" },
        { flags: "--no-cache", description: "Parse every file and leave the parse cache untouched" },
        { flags: "--normalized", description: "Also write graph.normalized.jsonl: machine-independent, deterministically ordered", type: "boolean" },
      ],
      action: exportCommand,
    },
    {
      name: "smoke",
      description: "Run sample repository smoke validation scans.",
      options: [
        { flags: "--suite <suite>", description: "Smoke suite: standing, internet, or all", default: "all" },
        { flags: "--report <path>", description: "Machine-readable smoke report path", default: ".concentrate/smoke-report.json" },
        { flags: "--semantic-samples <n>", description: "Semantic sample rows per category", type: "number", default: 10 },
        { flags: "--incremental-benchmark", description: "Rescan each sample with a warm parse cache and check the graph is unchanged", type: "boolean" },
        { flags: "--allow-missing", description: "Skip missing sample repositories instead of failing", type: "boolean" },
      ],
      action: smokeCommand,
    },
    {
      name: "mcp",
      description: "Run a read-only MCP server over the graph store.",
      options: [
        { flags: "-d, --database <path>", description: "Graph store directory", default: ".concentrate/graph" },
      ],
      action: mcpCommand,
    },
  ],
};

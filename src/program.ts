import type { ProgramSpec } from "./adapters/cli/args.js";
import { scanCommand } from "./commands/scan.js";
import { statsCommand } from "./commands/stats.js";
import { queryCommand } from "./commands/query.js";
import { exportCommand } from "./commands/export.js";
import { smokeCommand } from "./commands/smoke.js";
import { mcpCommand } from "./commands/mcp.js";
import { watchCommand } from "./commands/watch.js";
import { affectedCommand } from "./commands/affected.js";
import { cyclesCommand, unusedCommand } from "./commands/check.js";
import { initCommand } from "./commands/init.js";
import { nudgeCommand } from "./commands/nudge.js";
import { uiCommand } from "./commands/ui.js";

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
        { flags: "--watch <path>", description: "Project to keep the graph current for: scan it at start and rescan when files change; tool calls wait for a pending rescan" },
        { flags: "--tools <names>", description: "Comma-separated tools to list (the others stay callable); default: CONCENTRATE_MCP_TOOLS, else all" },
        { flags: "--manifest <path>", description: "Scan manifest used to flag answers that name changed files (default: scan-manifest.json next to the store)" },
        { flags: "--continue-on-error", description: "With --watch: write a partial graph when a file fails to parse", type: "boolean" },
        { flags: "--include <pattern>", description: "With --watch: include glob pattern, repeatable", multiple: true },
        { flags: "--exclude <pattern>", description: "With --watch: exclude glob pattern, repeatable", multiple: true },
        { flags: "--api-origin <url>", description: "With --watch: origin that serves this project's routes, repeatable", multiple: true },
        { flags: "--cache-dir <path>", description: "With --watch: parse cache directory (default: cache next to the store)" },
      ],
      action: mcpCommand,
    },
    {
      name: "affected",
      description: "List the test files that reach the given files through imports and calls.",
      args: [{ name: "files", description: "Changed files (or directories), relative to the scanned project", variadic: true }],
      options: [
        { flags: "-d, --database <path>", description: "Graph store directory", default: ".concentrate/graph" },
        { flags: "--stdin", description: "Also read file names from stdin, one per line (git diff --name-only | concentrate affected --stdin)", type: "boolean" },
        { flags: "--json", description: "Print the changed files, unmatched arguments and tests with depth as JSON", type: "boolean" },
        { flags: "--max-depth <n>", description: "Import and call hops to follow", type: "number", default: 20 },
      ],
      action: affectedCommand,
    },
    {
      name: "cycles",
      description: "List import cycles; exit code 1 when there are more than --max (default 0) runtime cycles.",
      options: [
        { flags: "-d, --database <path>", description: "Graph store directory", default: ".concentrate/graph" },
        { flags: "--scope <scope>", description: "file (default) or package" },
        { flags: "--path <path>", description: "Only cycles through this file, directory or package" },
        { flags: "--include-type-only", description: "Count cycles that only go through type-only imports too", type: "boolean" },
        { flags: "--max <n>", description: "Cycles allowed before the exit code is 1", type: "number", default: 0 },
        { flags: "--json", description: "Print the cycles as JSON", type: "boolean" },
      ],
      action: cyclesCommand,
    },
    {
      name: "unused",
      description: "List unused export candidates; exit code 1 when there are more than --max (default 0).",
      options: [
        { flags: "-d, --database <path>", description: "Graph store directory", default: ".concentrate/graph" },
        { flags: "--file <path>", description: "Only exports of this file, directory or path suffix" },
        { flags: "--include-tests", description: "Also check test and fixture files", type: "boolean" },
        { flags: "--max <n>", description: "Candidates allowed before the exit code is 1", type: "number", default: 0 },
        { flags: "--json", description: "Print the candidates as JSON", type: "boolean" },
      ],
      action: unusedCommand,
    },
    {
      name: "init",
      description: "Write the MCP server config of Claude Code, Cursor and Codex into a project.",
      args: [{ name: "path", description: "Project path" }],
      options: [
        { flags: "-d, --database <path>", description: "Graph store directory (default: <path>/.concentrate/graph)" },
        { flags: "--client <name>", description: "claude, cursor or codex, repeatable (default: all three)", multiple: true },
        { flags: "--npx", description: "Start the server with npx -y concentrate instead of this build's CLI", type: "boolean" },
        { flags: "--watch", description: "Start the MCP server with --watch <path>: it scans at start and keeps the graph current while you edit", type: "boolean" },
        { flags: "--hooks", description: "Also install git hooks (post-commit, post-checkout, post-merge) that rescan the project in the background", type: "boolean" },
        { flags: "--no-instructions", description: "Do not write the Concentrate section into CLAUDE.md and AGENTS.md" },
        { flags: "--hook", description: "Also add an advisory Claude Code PreToolUse hook (.claude/settings.json) that points to the graph before Grep and Read", type: "boolean" },
      ],
      action: initCommand,
    },
    {
      name: "nudge",
      description: "Claude Code PreToolUse hook body: reads the hook input on stdin and prints advisory context once per session. Installed by init --hook.",
      options: [
        { flags: "-d, --database <path>", description: "Graph store directory", default: ".concentrate/graph" },
      ],
      action: nudgeCommand,
    },
    {
      name: "ui",
      description: "Start the optional local web interface (ui/); prints the install steps when it is not installed.",
      options: [
        { flags: "--port <n>", description: "Port to listen on (default: a free one)", type: "number" },
        { flags: "--no-open", description: "Do not open the browser" },
      ],
      action: uiCommand,
    },
  ],
};

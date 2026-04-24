#!/usr/bin/env node

import { Command } from "commander";
import { scanCommand } from "../commands/scan.js";
import { statsCommand } from "../commands/stats.js";
import { queryCommand } from "../commands/query.js";

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
  .action(queryCommand);

await program.parseAsync(process.argv);

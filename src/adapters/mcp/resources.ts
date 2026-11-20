import type { IQueryEngine } from "../../core/contracts/query-engine.js";
import { INVALID_PARAMS, McpProtocolError } from "./errors.js";
import { defaultLanguageTable } from "../../composition/default-registry.js";
import { graphSummary } from "../../core/queries/summary.js";

// MCP resources: one JSON summary of the scanned graph, small enough for an
// agent to read before choosing tools.

export const GRAPH_SUMMARY_URI = "concentrate://graph/summary";

export const resourceDefinitions = [
  {
    uri: GRAPH_SUMMARY_URI,
    name: "graph-summary",
    title: "Graph summary",
    description: "Overview of the scanned repository: node counts, languages, packages, the largest directories, hubs (most connected files, most called functions), routes and entrypoints by framework, and data model, env var and config counts.",
    mimeType: "application/json",
  },
];

export async function readResource(engine: IQueryEngine, uri: string): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  if (uri !== GRAPH_SUMMARY_URI) throw new McpProtocolError(INVALID_PARAMS, `Resource not found: ${uri}`, { uri });
  const summary = await graphSummary(engine, { codeLanguages: defaultLanguageTable.codeLanguages });
  return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(summary, null, 2) }] };
}

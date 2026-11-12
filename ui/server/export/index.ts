import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ServerResponse } from "node:http";
import { dotChunks } from "./dot.js";
import { graphmlChunks } from "./graphml.js";
import { HTML_NODE_CAP, htmlDocument } from "./html.js";
import { jsonChunks } from "./json.js";
import { jsonlZip, jsonlZipFromScan } from "./jsonl.js";
import { select, type SelectOptions, type Selection } from "./select.js";
import { HIDDEN_LABELS } from "../graph/kinds.js";

export const FORMATS = ["json", "jsonl", "graphml", "dot", "html"] as const;
export type ExportFormat = (typeof FORMATS)[number];

export type ExportRequest = SelectOptions & { project: string; format: ExportFormat };

export function parseExportRequest(params: URLSearchParams): ExportRequest {
  const format = params.get("format") ?? "json";
  if (!(FORMATS as readonly string[]).includes(format)) throw new Error(`format must be one of ${FORMATS.join(", ")}`);
  const scope = params.get("scope") ?? "graph";
  if (scope !== "graph" && scope !== "view") throw new Error("scope must be graph or view");
  const project = params.get("project");
  if (!project) throw new Error("`project` is required");
  return {
    project,
    format: format as ExportFormat,
    scope,
    types: params.get("types"),
    prefix: params.get("prefix") ?? undefined,
    focus: params.get("focus") ?? undefined,
  };
}

const visibleCount = (selection: Selection) => selection.nodes.filter((n) => !HIDDEN_LABELS.has(n.label)).length;

/** Streams the export as a download; nothing is written into the project. */
export async function sendExport(request: ExportRequest, response: ServerResponse): Promise<void> {
  const selection = await select(request.project, request);
  const base = `${path.basename(path.resolve(request.project)).replace(/[^\w.-]+/g, "_") || "graph"}-graph${request.scope === "view" ? "-view" : ""}`;
  const headers = (type: string, extension: string) => ({
    "content-type": `${type}; charset=utf-8`,
    "content-disposition": `attachment; filename="${base}.${extension}"`,
    "cache-control": "no-store",
  });

  // Large graphs: DOT and HTML default to the aggregated (file) level.
  const tooLarge = request.scope === "graph" && visibleCount(selection) > HTML_NODE_CAP;
  const aggregated = tooLarge ? await select(request.project, { scope: "view", types: request.types }) : null;

  if (request.format === "jsonl") {
    const data = request.scope === "graph" ? await jsonlZipFromScan(request.project) : jsonlZip(selection);
    response.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${base}-jsonl.zip"`, "content-length": data.length, "cache-control": "no-store" });
    response.end(data);
    return;
  }
  if (request.format === "html") {
    response.writeHead(200, headers("text/html", "html"));
    response.end(htmlDocument(selection, aggregated));
    return;
  }
  const chunks =
    request.format === "json" ? jsonChunks(selection)
    : request.format === "graphml" ? graphmlChunks(selection)
    : dotChunks(aggregated ?? selection, aggregated ? `The graph has more than ${HTML_NODE_CAP} nodes: this is the file level (the aggregated level).` : undefined);
  const [type, extension] = request.format === "json" ? ["application/json", "json"] : request.format === "graphml" ? ["application/xml", "graphml"] : ["text/vnd.graphviz", "dot"];
  response.writeHead(200, headers(type!, extension!));
  await pipeline(Readable.from(chunks), response);
}

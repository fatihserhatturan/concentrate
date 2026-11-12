import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { listDirectories } from "./api/fs.js";
import { parseScanRequest, runScan } from "./api/scan.js";
import { projectInfo } from "./api/project.js";
import { runQuery } from "./api/query.js";
import { preset } from "./graph/presets.js";
import { parseExportRequest, sendExport } from "./export/index.js";
import { neighbors, nodeDetail, nodeSource, overview, parseKinds, search, summary } from "./graph/views.js";
import { createToken, isAllowedHost, tokenFromRequest, tokenMatches } from "./security.js";

const WEB_DIST = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "dist");
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
};

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw new Error("Request body too large");
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text.length > 0 ? JSON.parse(text) : {};
}

async function serveStatic(url: URL, response: ServerResponse): Promise<void> {
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const file = path.normalize(path.join(WEB_DIST, requested));
  if (!file.startsWith(WEB_DIST + path.sep)) {
    response.writeHead(403).end();
    return;
  }
  try {
    const data = await readFile(file);
    response.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    response.end(data);
  } catch {
    response.writeHead(404, { "content-type": "text/plain" }).end("Not found (run `npm run build:web` in ui/)");
  }
}

export function createUiServer(token: string) {
  return createServer(async (request, response) => {
    try {
      if (!isAllowedHost(request.headers.host)) {
        response.writeHead(403).end("Forbidden host");
        return;
      }
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith("/api/")) {
        await serveStatic(url, response);
        return;
      }
      if (!tokenMatches(token, tokenFromRequest(request, url))) {
        sendJson(response, 401, { error: "Missing or wrong token" });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/fs") {
        sendJson(response, 200, await listDirectories(url.searchParams.get("path") ?? undefined));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/scan") {
        const scanRequest = parseScanRequest(await readBody(request));
        response.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        await runScan(scanRequest, (event) => response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        response.end();
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/project") {
        const target = url.searchParams.get("path");
        if (!target) throw new Error("`path` is required");
        sendJson(response, 200, await projectInfo(target));
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/query") {
        const body = (await readBody(request)) as { project?: string; query?: unknown };
        if (!body.project) throw new Error("`project` is required");
        sendJson(response, 200, await runQuery(body.project, body.query));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/export") {
        await sendExport(parseExportRequest(url.searchParams), response);
        return;
      }
      if (request.method === "GET" && (url.pathname.startsWith("/api/graph/") || url.pathname === "/api/search")) {
        const project = url.searchParams.get("project");
        if (!project) throw new Error("`project` is required");
        const param = (name: string) => url.searchParams.get(name);
        if (url.pathname === "/api/graph/summary") return sendJson(response, 200, await summary(project));
        if (url.pathname === "/api/graph/overview") {
          return sendJson(response, 200, await overview(project, param("level") ?? "package", param("prefix") ?? "", parseKinds(param("types"))));
        }
        if (url.pathname === "/api/graph/neighbors") {
          return sendJson(response, 200, await neighbors(project, param("id") ?? "", parseKinds(param("types")), Number(param("depth") ?? 1)));
        }
        if (url.pathname === "/api/graph/preset") return sendJson(response, 200, await preset(project, param("name") ?? ""));
        if (url.pathname === "/api/graph/node") return sendJson(response, 200, await nodeDetail(project, param("id") ?? ""));
        if (url.pathname === "/api/graph/source") return sendJson(response, 200, await nodeSource(project, param("id") ?? ""));
        if (url.pathname === "/api/search") return sendJson(response, 200, await search(project, param("q") ?? "", param("label") ?? undefined));
      }
      sendJson(response, 404, { error: "Unknown endpoint" });
    } catch (error) {
      if (!response.headersSent) sendJson(response, 400, { error: error instanceof Error ? error.message : String(error) });
      else response.end();
    }
  });
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const token = createToken();
  const port = Number(process.env.PORT ?? 0);
  const server = createUiServer(token);
  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    const actual = typeof address === "object" && address ? address.port : port;
    const url = `http://127.0.0.1:${actual}/#token=${token}`;
    console.log(`Concentrate UI: ${url}`);
    if (process.env.NO_OPEN !== "1") openBrowser(url);
  });
}

import type { IQueryEngine } from "../../core/contracts/query-engine.js";
import { optionalString } from "./args.js";
import { loadFunctions, matchesFileOrDirectory } from "./agent-tools/graph.js";
import type { PageWindow } from "./paging.js";

type Row = Record<string, unknown>;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);
const num = (value: unknown): number | null => (typeof value === "number" ? value : null);

// list_rpcs: the rpcs of `.proto` files with their messages, the generated Go
// server interface that serves them, and the methods that implement them.
export async function listRpcs(engine: IQueryEngine, args: Record<string, unknown>, window: PageWindow) {
  const name = optionalString(args.name)?.toLowerCase();
  const file = optionalString(args.file);

  const [rpcs, messages, served, implemented] = await Promise.all([
    engine.query(`
      MATCH (declaring:File)-[:DECLARES_SERVICE]->(service:Service)-[:HAS_RPC]->(rpc:Rpc)
      RETURN id(rpc) AS id, rpc.service AS service, rpc.name AS name, rpc.request AS request, rpc.response AS response,
        rpc.clientStreaming AS clientStreaming, rpc.serverStreaming AS serverStreaming, declaring.relativePath AS file, rpc.line AS line
    `),
    engine.query(`
      MATCH (rpc:Rpc)-[rel:RPC_REQUEST|RPC_RESPONSE]->(message:Message)
      MATCH (declaring:File)-[:DECLARES_MESSAGE]->(message)
      RETURN id(rpc) AS id, label(rel) AS relType, message.fullName AS message, declaring.relativePath AS file, message.line AS line
    `),
    engine.query(`
      MATCH (rpc:Rpc)-[rel:RPC_SERVED_BY]->(interface:Interface)
      MATCH (declaring:File)-[:DEFINES_INTERFACE]->(interface)
      RETURN id(rpc) AS id, interface.name AS name, declaring.relativePath AS file, interface.line AS line
    `),
    engine.query(`
      MATCH (rpc:Rpc)-[:RPC_IMPLEMENTED_BY]->(fn:Function)
      RETURN id(rpc) AS id, id(fn) AS fn
    `),
  ]) as Row[][];

  const functions = await loadFunctions(engine, [...new Set(implemented!.map((row) => String(row.fn)))]);
  const group = (rows: readonly Row[]) => {
    const map = new Map<string, Row[]>();
    for (const row of rows) map.set(String(row.id), [...(map.get(String(row.id)) ?? []), row]);
    return map;
  };
  const messagesByRpc = group(messages!);
  const servedByRpc = group(served!);
  const implementedByRpc = group(implemented!);

  const result = rpcs!
    .filter((rpc) => (!name || `${String(rpc.service)}/${String(rpc.name)}`.toLowerCase().includes(name)) && (!file || matchesFileOrDirectory(str(rpc.file), file)))
    .map((rpc) => {
      const id = String(rpc.id);
      const messageOf = (relType: string) => {
        const row = (messagesByRpc.get(id) ?? []).find((entry) => entry.relType === relType);
        return row ? { message: str(row.message), file: str(row.file), line: num(row.line) } : null;
      };
      const client = rpc.clientStreaming === true;
      const server = rpc.serverStreaming === true;
      const serving = servedByRpc.get(id)?.[0];
      return {
        service: str(rpc.service),
        name: str(rpc.name),
        file: str(rpc.file),
        line: num(rpc.line),
        request: str(rpc.request),
        response: str(rpc.response),
        ...(client || server ? { streaming: client && server ? "both" : client ? "client" : "server" } : {}),
        requestMessage: messageOf("RPC_REQUEST"),
        responseMessage: messageOf("RPC_RESPONSE"),
        servedBy: serving ? { interface: str(serving.name), file: str(serving.file), line: num(serving.line) } : null,
        implementations: (implementedByRpc.get(id) ?? [])
          .map((row) => functions.get(String(row.fn)))
          .filter((info) => info !== undefined)
          .map((info) => ({ name: info!.className ? `${info!.className}.${info!.name}` : info!.name, file: info!.file, line: info!.line }))
          .sort((a, b) => String(a.file).localeCompare(String(b.file)) || Number(a.line) - Number(b.line)),
      };
    })
    .sort((a, b) => String(a.service).localeCompare(String(b.service)) || String(a.name).localeCompare(String(b.name)));

  return {
    query: { name: name ?? null, file: file ?? null },
    totalRpcs: result.length,
    rpcs: window.take(result),
    note: "rpcs come from .proto files. servedBy is the generated Go server interface (found through its grpc.ServiceDesc, which must list the method); implementations are the methods of every type that implements it, not the Unimplemented stub. An rpc with no servedBy has no generated Go code in the scan; one with servedBy and no implementations is declared but unimplemented.",
  };
}

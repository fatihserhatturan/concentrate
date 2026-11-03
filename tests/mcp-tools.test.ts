import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { SCHEMA_VERSION } from "../src/adapters/store/schema.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { handleMcpRequest } from "../src/adapters/mcp/server.js";

describe("MCP tools", () => {
  it("handles MCP initialize, tools/list, tools/call, and unsupported methods", async () => {
    const { writer } = await createMcpFixture();
    let opened = 0;
    const engineFactory = async () => {
      opened += 1;
      return writer;
    };

    try {
      const initialize = await handleMcpRequest({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {},
      }, engineFactory) as {
        protocolVersion?: string;
        capabilities?: { tools?: unknown };
        serverInfo?: { name?: string };
      };
      assert.equal(initialize.protocolVersion, "2025-11-25");
      assert.ok(initialize.capabilities?.tools);
      assert.equal(initialize.serverInfo?.name, "concentrate");
      assert.equal(opened, 0, "initialize should not open the graph database");

      const toolsList = await handleMcpRequest({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
        params: {},
      }, engineFactory) as { tools?: Array<{ name?: string }> };
      assert.ok(toolsList.tools?.some((tool) => tool.name === "graph_stats"));
      assert.ok(toolsList.tools?.some((tool) => tool.name === "list_routes"));
      assert.equal(opened, 0, "tools/list should not open the graph database");

      const call = await handleMcpRequest({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: {
          name: "graph_stats",
          arguments: {},
        },
      }, engineFactory) as { content?: Array<{ type?: string; text?: string }> };
      assert.equal(call.content?.[0]?.type, "text");
      assert.equal(JSON.parse(call.content?.[0]?.text ?? "{}").schemaVersion, SCHEMA_VERSION);
      assert.equal(opened, 1, "tools/call should open the graph database lazily");

      await assert.rejects(
        () => handleMcpRequest({
          jsonrpc: "2.0",
          id: 4,
          method: "prompts/list",
          params: {},
        }, engineFactory),
        /Method not found/,
      );
    } finally {
      await writer.close();
    }
  });

  it("exposes graph stats, definitions, callers, exports, and import chains", async () => {
    const { databasePath, writer } = await createMcpFixture();
    try {
      const stats = await callJsonTool(writer, "graph_stats", {});
      assert.ok(Array.isArray(stats.stats));
      assert.equal(stats.schemaVersion, SCHEMA_VERSION);

      const definitions = await callJsonTool(writer, "find_definitions", {
        name: "target",
        exact: true,
      });
      assert.equal(definitions.definitions[0].name, "target");
      assert.equal(definitions.definitions[0].file, "src/target.ts");

      const callers = await callJsonTool(writer, "find_callers", {
        name: "target",
        exact: true,
      });
      assert.equal(callers.callers[0].target, "target");
      assert.equal(callers.callers[0].file, "src/middle.ts");

      const exports = await callJsonTool(writer, "list_exports", {
        file: "src/target.ts",
      });
      assert.equal(exports.exports[0].name, "target");
      assert.equal(exports.exports[0].kind, "Function");

      const chain = await callJsonTool(writer, "trace_import_chain", {
        from: "src/index.ts",
        to: "src/target.ts",
      });
      assert.equal(chain.found, true);
      assert.deepEqual(chain.chain, ["src/index.ts", "src/middle.ts", "src/target.ts"]);

      const routes = await callJsonTool(writer, "list_routes", {
        file: "src/service.ts",
      });
      assert.equal(routes.routes[0].method, "GET");
      assert.equal(routes.routes[0].path, "/users");
      assert.equal(routes.routes[0].handler, "listUsers");

      for (const file of ["src", "src/", "service.ts"]) {
        const scoped = await callJsonTool(writer, "list_routes", { file });
        assert.equal(scoped.routes[0]?.path, "/users", file);
        assert.equal(scoped.note, undefined, file);
      }
      const directoryExports = await callJsonTool(writer, "list_exports", { file: "src" });
      assert.ok(directoryExports.exports.some((row: any) => row.name === "target"));
      const missing = await callJsonTool(writer, "list_routes", { file: "lib" });
      assert.deepEqual(missing.routes, []);
      assert.match(missing.note, /No scanned file or directory matched/);

      const entrypoints = await callJsonTool(writer, "list_entrypoints", {
        kind: "queue",
      });
      assert.equal(entrypoints.entrypoints[0].trigger, "cleanup");
      assert.equal(entrypoints.entrypoints[0].handler, "handleJob");

      const envConfig = await callJsonTool(writer, "list_env_config", {
        name: "DATABASE",
      });
      assert.ok(envConfig.envConfig.some((row: any) => row.name === "DATABASE_URL"));

      const dataAccess = await callJsonTool(writer, "list_data_access", {
        model: "user",
        operation: "read",
      });
      assert.ok(dataAccess.dataAccess.some((row: any) => row.model === "user" && row.library === "prisma"));

      const listResponse = await handleMcpRequest({ id: 1, method: "tools/list" }, async () => writer);
      const tools = (listResponse as { tools?: Array<{ name?: string }> }).tools ?? [];
      assert.ok(tools.some((tool) => tool.name === "list_data_access"));
    } finally {
      await writer.close();
    }

    assert.ok(databasePath.endsWith("graph"));
  });

  it("find_callers includes callers that are class methods", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-mcp-methods-"));
    const graph = await buildCodeGraph(path.resolve("fixtures/nestjs-injection"), { continueOnError: false });
    const writer = await GraphStore.open(path.join(root, "graph"));
    try {
      await writer.reset();
      await writer.write(graph.nodes, graph.relationships);

      const result = await callJsonTool(writer, "find_callers", { name: "findAll" });
      const methodCaller = result.callers.find((row: any) => row.callerKind === "Method");
      assert.ok(methodCaller, `expected a method caller, got ${JSON.stringify(result.callers)}`);
      assert.equal(methodCaller.caller, "findAll");
      assert.equal(methodCaller.className, "UsersController");
      assert.equal(methodCaller.file, "users.controller.ts");
      assert.equal(methodCaller.relationship, "CALLS");
    } finally {
      await writer.close();
    }
  });
});

async function callJsonTool(
  writer: GraphStore,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, any>> {
  const result = await callMcpTool(writer, name, args);
  return JSON.parse(result.content[0]?.text ?? "{}") as Record<string, any>;
}

async function createMcpFixture(): Promise<{ databasePath: string; writer: GraphStore }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-mcp-"));
  const projectPath = path.join(root, "project");
  const databasePath = path.join(root, "graph");
  await mkdir(path.join(projectPath, "src"), { recursive: true });
  await writeFile(
    path.join(projectPath, "src", "index.ts"),
    "import { middle } from './middle';\nexport function start() {\n  return middle();\n}\n",
    "utf8",
  );
  await writeFile(
    path.join(projectPath, "src", "middle.ts"),
    "import { target } from './target';\nexport function middle() {\n  return target();\n}\n",
    "utf8",
  );
  await writeFile(
    path.join(projectPath, "src", "target.ts"),
    "export function target() {\n  return 'ok';\n}\n",
    "utf8",
  );
  await writeFile(
    path.join(projectPath, "src", "config.ts"),
    "export const FEATURE_FLAG = 'FEATURE_USERS';\n",
    "utf8",
  );
  await writeFile(
    path.join(projectPath, "src", "service.ts"),
    [
      "import { FEATURE_FLAG } from './config';",
      "",
      "const app = express();",
      "const queue = createQueue();",
      "const prisma = createPrismaClient();",
      "",
      "export async function listUsers(req, res) {",
      "  const databaseUrl = process.env['DATABASE_URL'];",
      "  const users = await prisma.user.findMany();",
      "  res.set('x-feature', FEATURE_FLAG);",
      "  res.json({ users, databaseUrl });",
      "}",
      "",
      "function handleJob(job) {",
      "  return job.id;",
      "}",
      "",
      "app.get('/users', listUsers);",
      "queue.process('cleanup', handleJob);",
      "",
    ].join("\n"),
    "utf8",
  );

  const graph = await buildCodeGraph(projectPath, {
    continueOnError: false,
  });
  const writer = await GraphStore.open(databasePath);
  await writer.reset();
  await writer.write(graph.nodes, graph.relationships);
  return { databasePath, writer };
}

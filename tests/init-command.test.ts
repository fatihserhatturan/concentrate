import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCommandArgs } from "../src/adapters/cli/args.js";
import { mcpServerEntry, mergeCodexToml, mergeJsonConfig, runInitAdapter } from "../src/adapters/cli/index.js";
import { program } from "../src/program.js";

const entry = { command: "node", args: ["/cli.js", "mcp", "--database", "/p/.concentrate/graph"] };

describe("init: MCP server entry", () => {
  it("runs this build's CLI under the current Node, or npx", () => {
    assert.deepEqual(mcpServerEntry("/g", { npx: false, cliPath: "/cli.js" }), { command: process.execPath, args: ["/cli.js", "mcp", "--database", "/g"] });
    assert.deepEqual(mcpServerEntry("/g", { npx: true }), { command: "npx", args: ["-y", "concentrate", "mcp", "--database", "/g"] });
  });
});

describe("init: JSON configs", () => {
  it("adds the server and keeps other servers and keys", () => {
    const merged = JSON.parse(mergeJsonConfig(JSON.stringify({ other: 1, mcpServers: { x: { command: "x" }, concentrate: { command: "old" } } }), entry));
    assert.deepEqual(merged, { other: 1, mcpServers: { x: { command: "x" }, concentrate: entry } });
    assert.deepEqual(JSON.parse(mergeJsonConfig(null, entry)), { mcpServers: { concentrate: entry } });
    assert.deepEqual(JSON.parse(mergeJsonConfig("  \n", entry)), { mcpServers: { concentrate: entry } });
  });

  it("refuses files it cannot merge", () => {
    assert.throws(() => mergeJsonConfig("[]", entry, ".mcp.json"), /\.mcp\.json is not a JSON object/);
    assert.throws(() => mergeJsonConfig("{\"mcpServers\": []}", entry), /mcpServers is not an object/);
    assert.throws(() => mergeJsonConfig("{", entry), SyntaxError);
  });
});

describe("init: Codex TOML", () => {
  const table = '[mcp_servers.concentrate]\ncommand = "node"\nargs = ["/cli.js", "mcp", "--database", "/p/.concentrate/graph"]\n';

  it("appends the table and keeps the rest", () => {
    assert.equal(mergeCodexToml(null, entry), table);
    assert.equal(mergeCodexToml('model = "o3"\n\n[mcp_servers.x]\ncommand = "x"\n\n', entry), `model = "o3"\n\n[mcp_servers.x]\ncommand = "x"\n\n${table}`);
  });

  it("replaces an earlier table and its subtables in place", () => {
    const existing = [
      'model = "o3"',
      "",
      "[mcp_servers.concentrate]",
      'command = "old"',
      "",
      "[mcp_servers.concentrate.env]",
      'A = "1"',
      "",
      "[mcp_servers.x]",
      'command = "x"',
      "",
    ].join("\n");
    assert.equal(mergeCodexToml(existing, entry), `model = "o3"\n\n${table}\n[mcp_servers.x]\ncommand = "x"\n`);
    assert.equal(mergeCodexToml(mergeCodexToml(existing, entry), entry), mergeCodexToml(existing, entry));
  });

  it("quotes paths with TOML escapes", () => {
    assert.match(mergeCodexToml(null, { command: "C:\\node.exe", args: ['a "b"'] }), /command = "C:\\\\node\.exe"\nargs = \["a \\"b\\""\]/);
  });
});

describe("init: command", () => {
  it("parses its options", () => {
    const init = program.commands.find((command) => command.name === "init")!;
    assert.deepEqual(parseCommandArgs(init, ["."]), { positionals: ["."], options: { client: [], npx: false } });
    assert.deepEqual(parseCommandArgs(init, [".", "--client", "codex", "--npx", "-d", "g"]).options, { client: ["codex"], npx: true, database: "g" });
  });

  it("writes every client's config into the project", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "concentrate-init-"));
    const log = console.log;
    console.log = () => {};
    try {
      writeFileSync(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { x: { command: "x" } } }));
      await runInitAdapter(root, { client: [], npx: true });
      const database = path.join(root, ".concentrate/graph");
      const expected = { command: "npx", args: ["-y", "concentrate", "mcp", "--database", database] };
      assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".mcp.json"), "utf8")).mcpServers, { x: { command: "x" }, concentrate: expected });
      assert.deepEqual(JSON.parse(readFileSync(path.join(root, ".cursor/mcp.json"), "utf8")).mcpServers, { concentrate: expected });
      assert.match(readFileSync(path.join(root, ".codex/config.toml"), "utf8"), /^\[mcp_servers\.concentrate\]\ncommand = "npx"/);
      await assert.rejects(runInitAdapter(root, { client: ["vscode"], npx: false }), /Unknown client vscode/);
    } finally {
      console.log = log;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

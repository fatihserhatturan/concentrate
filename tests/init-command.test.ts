import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parseCommandArgs } from "../src/adapters/cli/args.js";
import { mcpServerEntry, mergeCodexToml, mergeJsonConfig, runInitAdapter } from "../src/adapters/cli/index.js";
import { program } from "../src/program.js";
import { mkdirSync } from "node:fs";
import { mergeClaudeHook, mergeInstructions, nudgeCommand, nudgeOutput, SECTION, SECTION_END, SECTION_START } from "../src/adapters/cli/init-steering.js";

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
    assert.deepEqual(parseCommandArgs(init, ["."]), { positionals: ["."], options: { client: [], npx: false, instructions: true, hook: false } });
    assert.deepEqual(parseCommandArgs(init, [".", "--client", "codex", "--npx", "-d", "g"]).options, { client: ["codex"], npx: true, database: "g", instructions: true, hook: false });
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

describe("init: agent steering", () => {
  it("appends the fenced section, replaces it in place and keeps the rest", () => {
    assert.equal(mergeInstructions(null), `${SECTION}\n`);
    const appended = mergeInstructions("# Mine\n\nrules\n");
    assert.equal(appended, `# Mine\n\nrules\n\n${SECTION}\n`);
    const edited = appended.replace("## Code graph", "## Old title").replace("# Mine", "# Mine!");
    assert.equal(mergeInstructions(`${edited}\ntail\n`), `# Mine!\n\nrules\n\n${SECTION}\n\ntail\n`);
    assert.equal(mergeInstructions(mergeInstructions("x")), mergeInstructions("x"));
    // A lone start marker is not cut out.
    assert.equal(mergeInstructions(`a\n${SECTION_START}\nuser text\n`), `a\n${SECTION_START}\nuser text\n\n${SECTION}\n`);
    assert.ok(SECTION.endsWith(SECTION_END));
  });

  it("adds the hook once and keeps other settings and hooks", () => {
    const command = nudgeCommand("/g", { npx: false, cliPath: "/cli.js" });
    const other = { matcher: "Bash", hooks: [{ type: "command", command: "echo" }] };
    const first = mergeClaudeHook(JSON.stringify({ model: "x", hooks: { PreToolUse: [other], Stop: [] } }), command);
    const parsed = JSON.parse(first);
    assert.equal(parsed.model, "x");
    assert.deepEqual(parsed.hooks.Stop, []);
    assert.deepEqual(parsed.hooks.PreToolUse, [other, { matcher: "Grep|Read", hooks: [{ type: "command", command }] }]);
    const moved = mergeClaudeHook(first, nudgeCommand("/other", { npx: true, cliPath: "" }));
    assert.equal(JSON.parse(moved).hooks.PreToolUse.length, 2);
    assert.match(JSON.parse(moved).hooks.PreToolUse[1].hooks[0].command, /^npx -y concentrate nudge --database "\/other"$/u);
    assert.throws(() => mergeClaudeHook('{"hooks": []}', command), /hooks is not an object/);
  });

  it("nudges once per session, only when a graph exists", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "concentrate-nudge-"));
    try {
      const database = path.join(dir, "graph");
      const input = { session_id: "s-1", tool_name: "Grep" };
      assert.equal(nudgeOutput(input, { databasePath: database, stateDir: dir }), null);
      mkdirSync(database);
      const out = JSON.parse(nudgeOutput(input, { databasePath: database, stateDir: dir })!);
      assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
      assert.match(out.hookSpecificOutput.additionalContext, /find_callers/u);
      assert.equal(out.permissionDecision, undefined);
      assert.equal(nudgeOutput(input, { databasePath: database, stateDir: dir }), null);
      assert.notEqual(nudgeOutput({ session_id: "s-2" }, { databasePath: database, stateDir: dir }), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes the sections and the hook through init", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "concentrate-init-steer-"));
    const log = console.log;
    console.log = () => {};
    try {
      writeFileSync(path.join(root, "AGENTS.md"), "# Team rules\n");
      await runInitAdapter(root, { client: [], npx: true, hook: true });
      assert.match(readFileSync(path.join(root, "CLAUDE.md"), "utf8"), /concentrate:start/u);
      const agents = readFileSync(path.join(root, "AGENTS.md"), "utf8");
      assert.ok(agents.startsWith("# Team rules\n"));
      assert.match(agents, /find_callers/u);
      assert.equal(JSON.parse(readFileSync(path.join(root, ".claude/settings.json"), "utf8")).hooks.PreToolUse[0].matcher, "Grep|Read");
      await runInitAdapter(root, { client: [], npx: true, hook: true });
      assert.equal(readFileSync(path.join(root, "AGENTS.md"), "utf8"), agents);

      const bare = mkdtempSync(path.join(os.tmpdir(), "concentrate-init-bare-"));
      await runInitAdapter(bare, { client: ["claude"], npx: true, instructions: false });
      assert.throws(() => readFileSync(path.join(bare, "CLAUDE.md")), /ENOENT/u);
      rmSync(bare, { recursive: true, force: true });
    } finally {
      console.log = log;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

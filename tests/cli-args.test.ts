import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCommandArgs, runCli, type CommandSpec, type ProgramSpec } from "../src/adapters/cli/args.js";
import { program as concentrate } from "../src/program.js";

function fakeProgram(calls: unknown[][]): ProgramSpec {
  const record = async (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    name: "tool",
    description: "A test tool.",
    version: "1.2.3",
    commands: [
      {
        name: "scan",
        description: "Scan a path.",
        args: [{ name: "path", description: "Path to scan" }],
        options: [
          { flags: "-d, --database <path>", description: "Database path", default: "graph.db" },
          { flags: "--verbose", description: "Talk more", type: "boolean" },
          { flags: "--max-files <n>", description: "File limit", type: "number" },
          { flags: "--include <pattern>", description: "Include pattern, repeatable", multiple: true },
          { flags: "--exclude <pattern>", description: "Exclude pattern", multiple: true },
          { flags: "--no-retry-lock", description: "Do not retry" },
        ],
        action: record,
      },
      { name: "stats", description: "Show stats.", options: [], action: record },
    ],
  };
}

async function run(argv: string[]) {
  const calls: unknown[][] = [];
  let stdout = "";
  let stderr = "";
  const code = await runCli(fakeProgram(calls), argv, {
    stdout: (text) => { stdout += text; },
    stderr: (text) => { stderr += text; },
  });
  return { code, stdout, stderr, calls };
}

describe("CLI argument router", () => {
  it("passes positionals and options with defaults to the action", async () => {
    const { code, calls } = await run(["scan", "src"]);
    assert.equal(code, 0);
    assert.deepEqual(calls, [["src", { database: "graph.db", verbose: false, include: [], exclude: [], retryLock: true }]]);
  });

  it("parses short flags, inline values, numbers, repeatable and negated flags", async () => {
    const { code, calls } = await run([
      "scan", "-d", "x.db", "--include", "a/**", "src", "--include=b", "--max-files", "7", "--verbose", "--no-retry-lock",
    ]);
    assert.equal(code, 0);
    assert.deepEqual(calls, [["src", {
      database: "x.db",
      verbose: true,
      maxFiles: 7,
      include: ["a/**", "b"],
      exclude: [],
      retryLock: false,
    }]]);
  });

  it("suggests a close command name", async () => {
    const { code, stderr } = await run(["scna", "."]);
    assert.equal(code, 1);
    assert.equal(stderr, "error: unknown command 'scna'. Did you mean 'scan'?\n");
  });

  it("suggests a close option name", async () => {
    const { code, stderr } = await run(["scan", "src", "--exlude", "dist"]);
    assert.equal(code, 1);
    assert.equal(stderr, "error: unknown option '--exlude'. Did you mean '--exclude'?\n");
  });

  for (const [argv, message] of [
    [["scan", "src", "--bogus"], "error: unknown option '--bogus'\n"],
    // One-letter short options get no suggestion: `stats` has only -h, which
    // is one edit away from any of them.
    [["stats", "-x"], "error: unknown option '-x'\n"],
    [["scan", "src", "-x"], "error: unknown option '-x'\n"],
    [["--bogus"], "error: unknown option '--bogus'\n"],
    [["bogus"], "error: unknown command 'bogus'\n"],
    [["scan"], "error: missing required argument 'path'\n"],
    [["scan", "a", "b"], "error: too many arguments for 'scan'. Expected 1 argument but got 2.\n"],
    [["scan", "src", "--database"], "error: option '-d, --database <path>' argument missing\n"],
    [["scan", "src", "--max-files", "abc"], "error: option '--max-files <n>' argument 'abc' is invalid. Expected an integer.\n"],
  ] as const) {
    it(`rejects ${argv.join(" ")} with exit code 1`, async () => {
      const { code, stderr, calls } = await run([...argv]);
      assert.equal(code, 1);
      assert.equal(stderr, message);
      assert.deepEqual(calls, []);
    });
  }

  it("prints the version", async () => {
    for (const flag of ["-V", "--version"]) {
      const { code, stdout } = await run([flag]);
      assert.equal(code, 0);
      assert.equal(stdout, "1.2.3\n");
    }
  });

  it("prints root help on --help, and on stderr with exit 1 when no command is given", async () => {
    const help = await run(["--help"]);
    assert.equal(help.code, 0);
    assert.equal(help.stdout, [
      "Usage: tool [options] [command]",
      "",
      "A test tool.",
      "",
      "Options:",
      "  -V, --version          output the version number",
      "  -h, --help             display help for command",
      "",
      "Commands:",
      "  scan [options] <path>  Scan a path.",
      "  stats [options]        Show stats.",
      "  help [command]         display help for command",
      "",
    ].join("\n"));

    const none = await run([]);
    assert.equal(none.code, 1);
    assert.equal(none.stderr, help.stdout);
    assert.equal((await run(["help"])).stdout, help.stdout);
  });

  it("prints command help with arguments, defaults and wrapped descriptions", async () => {
    const help = await run(["scan", "--help"]);
    assert.equal(help.code, 0);
    assert.deepEqual(help.calls, []);
    assert.equal(help.stdout, [
      "Usage: tool scan [options] <path>",
      "",
      "Scan a path.",
      "",
      "Arguments:",
      "  path                   Path to scan",
      "",
      "Options:",
      "  -d, --database <path>  Database path (default: \"graph.db\")",
      "  --verbose              Talk more (default: false)",
      "  --max-files <n>        File limit",
      "  --include <pattern>    Include pattern, repeatable (default: [])",
      "  --exclude <pattern>    Exclude pattern (default: [])",
      "  --no-retry-lock        Do not retry",
      "  -h, --help             display help for command",
      "",
    ].join("\n"));
    assert.equal((await run(["help", "scan"])).stdout, help.stdout);
    assert.equal((await run(["scan", "-h"])).stdout, help.stdout);
  });

  it("wraps long descriptions under the description column", async () => {
    const command: CommandSpec = {
      name: "x",
      description: "X.",
      options: [{ flags: "--long", description: "word ".repeat(20).trim() }],
      action: async () => {},
    };
    let stdout = "";
    await runCli({ name: "t", description: "T.", version: "0", commands: [command] }, ["x", "--help"], {
      stdout: (text) => { stdout += text; },
      stderr: () => {},
      columns: 40,
    });
    const lines = stdout.split("\n").filter((line) => line.includes("word"));
    assert.ok(lines.length > 1);
    for (const line of lines) {
      assert.ok(line.length <= 40, `line too long: ${line}`);
      assert.equal(line.indexOf("word"), "  -h, --help  ".length);
    }
  });
});

describe("concentrate program spec", () => {
  it("keeps the options the command adapters expect", () => {
    const scan = concentrate.commands.find((command) => command.name === "scan")!;
    assert.deepEqual(parseCommandArgs(scan, ["."]), {
      positionals: ["."],
      options: {
        database: ".concentrate/graph",
        continueOnError: false,
        include: [],
        exclude: [],
        apiOrigin: [],
        retryLock: true,
        cacheDir: ".concentrate/cache",
        cache: true,
        manifest: ".concentrate/scan-manifest.json",
      },
    });
    assert.equal(parseCommandArgs(scan, [".", "--no-cache"]).options.cache, false);
    assert.deepEqual(parseCommandArgs(scan, [".", "--api-origin", "https://a.io", "--api-origin", "https://b.io"]).options.apiOrigin, ["https://a.io", "https://b.io"]);

    const smoke = concentrate.commands.find((command) => command.name === "smoke")!;
    assert.deepEqual(parseCommandArgs(smoke, []).options, {
      suite: "all",
      report: ".concentrate/smoke-report.json",
      semanticSamples: 10,
      incrementalBenchmark: false,
      allowMissing: false,
    });
  });
});

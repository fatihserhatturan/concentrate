// What a simple shell command starts, as references the contributor resolves
// against the files and entrypoints of the scan: `node dist/index.js`,
// `tsx scripts/x.ts`, `go run ./cmd/server`, `python manage.py`,
// `./scripts/deploy.sh`, `npm run build`, `make test`.

export type CommandRef =
  | { kind: "file"; path: string }
  // A Go package directory (`./cmd/server`) or file (`main.go`), as `go run` takes it.
  | { kind: "go"; path: string }
  | { kind: "python-module"; module: string }
  | { kind: "npm"; script: string; dir?: string }
  | { kind: "make"; target: string; dir?: string };

// Splits on whitespace outside quotes and drops the quotes.
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: string | null = null;
  let started = false;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (quote) {
      if (char === "\\" && quote === '"' && index + 1 < command.length) {
        current += command[++index];
      } else if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/u.test(char)) {
      if (started || current !== "") tokens.push(current);
      current = "";
      started = false;
    } else if (char === "\\" && index + 1 < command.length) {
      current += command[++index];
    } else {
      current += char;
    }
  }
  if (started || current !== "") tokens.push(current);
  return tokens;
}

const WRAPPERS = new Set(["sudo", "exec", "time", "nohup", "command", "nice", "env", "npx", "cross-env", "dotenv", "xvfb-run", "wait-on", "start-server-and-test"]);
const JS_RUNNERS = new Set(["node", "nodemon", "tsx", "ts-node", "ts-node-esm", "bun", "deno", "babel-node", "esno", "vite-node", "jiti"]);
const PYTHON = /^(?:python|python3|python3\.\d+|py|pypy3?)$/u;
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "source", ".", "pwsh", "powershell"]);
const NODE_VALUE_FLAGS = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--env-file", "-e", "--eval", "-p", "--print", "--inspect-brk"]);
const PM_BUILTINS = new Set([
  "install", "i", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "init", "exec", "dlx", "create", "publish", "pack", "link", "unlink",
  "audit", "outdated", "ci", "cache", "config", "set", "get", "login", "logout", "whoami", "version", "help", "x", "info", "list", "ls", "why", "prune",
  "dedupe", "rebuild", "root", "bin", "store", "patch", "import", "licenses", "global", "workspaces", "workspace", "plugin", "dev", "run-script", "run",
]);
// npm lifecycle shortcuts that run the script of the same name.
const NPM_SHORTCUTS = new Set(["test", "t", "tst", "start", "stop", "restart"]);

export function commandRefs(command: string): CommandRef[] {
  let tokens = tokenize(command);
  // `NAME=value` prefixes and wrappers (`sudo`, `cross-env A=b`, `npx`).
  for (;;) {
    const head = tokens[0];
    if (head === undefined) return [];
    if (/^[A-Za-z_]\w*=/u.test(head)) {
      tokens = tokens.slice(1);
    } else if (WRAPPERS.has(head)) {
      tokens = tokens.slice(1);
      while (tokens[0] !== undefined && (tokens[0].startsWith("-") || /^[A-Za-z_]\w*=/u.test(tokens[0]))) {
        if (tokens[0] === "--") {
          tokens = tokens.slice(1);
          break;
        }
        tokens = tokens.slice(1);
      }
    } else {
      break;
    }
  }
  const [name, ...rest] = tokens;
  if (!name) return [];
  const base = name.split("/").at(-1)!;

  if (base === "concurrently") {
    return rest.filter((token) => !token.startsWith("-")).flatMap((token) => commandRefs(token));
  }
  if (base === "npm-run-all" || base === "run-s" || base === "run-p") {
    return rest.filter((token) => !token.startsWith("-")).map((script) => ({ kind: "npm" as const, script }));
  }
  if (base === "bun") return [...firstFile(rest, ["run", "watch", "x"], true), ...packageManagerRefs("bun", rest)];
  if (JS_RUNNERS.has(base)) return firstFile(rest, base === "deno" ? ["run", "watch", "x"] : ["watch", "run"], true);
  if (PYTHON.test(base)) {
    const module = rest.indexOf("-m");
    if (module !== -1 && rest[module + 1]) return [{ kind: "python-module", module: rest[module + 1]! }];
    return firstFile(rest, [], false);
  }
  if (SHELLS.has(base)) {
    const file = rest.indexOf("-File");
    if (file !== -1 && rest[file + 1]) return [{ kind: "file", path: rest[file + 1]! }];
    return firstFile(rest.filter((token) => token !== "-c" && token !== "-Command"), [], false);
  }
  if (base === "make" || base === "gmake") return makeRefs(rest);
  if (base === "go") return goRefs(rest);
  if (base === "npm" || base === "pnpm" || base === "yarn") return packageManagerRefs(base, rest);
  // A script run by path: `./scripts/deploy.sh`, `scripts/build.ps1`, `bin/run.py`.
  if (/^(?:\.{1,2}\/|[\w.-]+\/)/u.test(name) || /\.(?:sh|bash|ps1|py|js|mjs|cjs|ts)$/u.test(name)) {
    return [{ kind: "file", path: name }];
  }
  return [];
}

function firstFile(args: string[], subcommands: string[], jsFlags: boolean): CommandRef[] {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--") continue;
    if (arg.startsWith("-")) {
      if (jsFlags && NODE_VALUE_FLAGS.has(arg)) index += 1;
      continue;
    }
    if (subcommands.includes(arg)) continue;
    if (/[$`]/u.test(arg)) return [];
    return [{ kind: "file", path: arg }];
  }
  return [];
}

function makeRefs(args: string[]): CommandRef[] {
  let dir: string | undefined;
  const targets: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "-C" || arg === "--directory") dir = args[++index];
    else if (arg.startsWith("-C") && arg.length > 2) dir = arg.slice(2);
    else if (arg === "-f" || arg === "--file" || arg === "-j") index += 1;
    else if (arg.startsWith("-") || arg.includes("=")) continue;
    else targets.push(arg);
  }
  return targets.filter((target) => !/[$`]/u.test(target)).map((target) => ({ kind: "make" as const, target, ...(dir ? { dir } : {}) }));
}

function goRefs(args: string[]): CommandRef[] {
  const [verb, ...rest] = args;
  if (verb !== "run" && verb !== "build" && verb !== "install") return [];
  const target = rest.find((arg) => !arg.startsWith("-") && (arg.startsWith(".") || arg.includes("/") || arg.endsWith(".go")));
  return target && !/[$`]/u.test(target) ? [{ kind: "go", path: target }] : [];
}

function packageManagerRefs(manager: string, args: string[]): CommandRef[] {
  let dir: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--prefix" || arg === "-C" || arg === "--cwd") dir = args[++index];
    else if (arg === "--workspace" || arg === "-w" || arg === "--filter" || arg === "-F") index += 1;
    else if (arg.startsWith("-")) continue;
    else rest.push(arg);
  }
  const [verb, script] = rest;
  const withDir = (name: string): CommandRef => ({ kind: "npm", script: name, ...(dir ? { dir } : {}) });
  if (verb === "run" || verb === "run-script") return script ? [withDir(script)] : [];
  if (verb && NPM_SHORTCUTS.has(verb)) return [withDir(verb === "t" || verb === "tst" ? "test" : verb)];
  if (manager !== "npm" && verb && !PM_BUILTINS.has(verb)) return [withDir(verb)];
  return [];
}

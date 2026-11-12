import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type UiAdapterOptions = {
  port?: number;
  open: boolean;
};

export type UiState = "missing" | "not-installed" | "ready";

/** `ui/` sits next to `src/` and `dist/`; it is a separate package that is never imported. */
export function defaultUiDirectory(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "ui");
}

export function uiState(uiDirectory: string): UiState {
  if (!existsSync(path.join(uiDirectory, "package.json"))) return "missing";
  return existsSync(path.join(uiDirectory, "node_modules")) ? "ready" : "not-installed";
}

export function installSteps(uiDirectory: string, state: Exclude<UiState, "ready">): string {
  if (state === "missing") {
    return `The optional UI is not part of this installation (${uiDirectory} does not exist).\nIt lives in the ui/ folder of the repository: https://github.com/fatihserhatturan/concentrate/tree/main/ui`;
  }
  return [
    "The optional UI is not installed yet. It has its own dependencies, which the core never installs:",
    "",
    `  cd ${uiDirectory}`,
    "  npm install",
    "  npm start",
    "",
    "After that, `concentrate ui` starts it.",
  ].join("\n");
}

/** Starts the UI server (building the web app on first use) and returns its exit code. */
export async function runUiAdapter(options: UiAdapterOptions, uiDirectory: string = defaultUiDirectory()): Promise<number> {
  const state = uiState(uiDirectory);
  if (state !== "ready") {
    console.error(installSteps(uiDirectory, state));
    return 1;
  }
  const env = {
    ...process.env,
    ...(options.port !== undefined ? { PORT: String(options.port) } : {}),
    ...(options.open ? {} : { NO_OPEN: "1" }),
  };
  if (!existsSync(path.join(uiDirectory, "web", "dist", "index.html"))) {
    console.error("Building the UI (first run)...");
    const built = spawnSync("npm", ["run", "build:web"], { cwd: uiDirectory, stdio: "inherit", env });
    if (built.status !== 0) return built.status ?? 1;
  }
  // The server imports the built core (dist/), so the CLI has to be built: `npm run build`.
  if (!existsSync(path.join(uiDirectory, "..", "dist", "api.js"))) {
    console.error("The core is not built. Run `npm run build` in the repository root, then `concentrate ui` again.");
    return 1;
  }
  return new Promise((resolve) => {
    const child = spawn("npm", ["run", "start:server"], { cwd: uiDirectory, stdio: "inherit", env });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", (error) => {
      console.error(`Could not start the UI: ${error.message}`);
      resolve(1);
    });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  });
}

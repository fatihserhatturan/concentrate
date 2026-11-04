// Builds the tree-sitter grammars Concentrate parses with into WebAssembly.
//   npm run grammars:build
//   npm run grammars:build -- go rust   (only these; the others are kept)
//
// Each grammar is downloaded at a pinned version with `npm pack` (no install
// scripts run) and compiled with the pinned tree-sitter CLI (devDependency).
// The .wasm files and vendor/grammars/manifest.json are committed; the runtime
// loads them through web-tree-sitter and never needs a native build.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const outDir = path.join(root, "vendor/grammars");

// grammar file name -> npm package, version, and grammar directory inside it.
const grammars = [
  { name: "javascript", package: "tree-sitter-javascript", version: "0.23.1", dir: "." },
  { name: "typescript", package: "tree-sitter-typescript", version: "0.23.2", dir: "typescript" },
  { name: "tsx", package: "tree-sitter-typescript", version: "0.23.2", dir: "tsx" },
  { name: "html", package: "tree-sitter-html", version: "0.23.2", dir: "." },
  { name: "python", package: "tree-sitter-python", version: "0.21.0", dir: "." },
  { name: "go", package: "tree-sitter-go", version: "0.25.0", dir: "." },
  { name: "rust", package: "tree-sitter-rust", version: "0.21.0", dir: "." },
];

const only = process.argv.slice(2);
const unknown = only.filter((name) => !grammars.some((grammar) => grammar.name === name));
if (unknown.length > 0) throw new Error(`Unknown grammar ${unknown.join(", ")}`);

const cli = path.join(root, "node_modules/.bin/tree-sitter");
const cliVersion = execFileSync(cli, ["--version"], { encoding: "utf8" }).trim();
const work = await mkdtemp(path.join(os.tmpdir(), "concentrate-grammars-"));
await mkdir(outDir, { recursive: true });

const previous = only.length > 0 ? JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8")) : { grammars: {} };
if (only.length > 0 && previous.cli !== cliVersion) throw new Error(`Grammars were built with ${previous.cli}; rebuild all with ${cliVersion}`);
const manifest = { cli: cliVersion, grammars: { ...previous.grammars } };
try {
  for (const grammar of grammars) {
    if (only.length > 0 && !only.includes(grammar.name)) continue;
    const source = path.join(work, `${grammar.package}-${grammar.version}`);
    await mkdir(source, { recursive: true });
    const tarball = execFileSync("npm", ["pack", `${grammar.package}@${grammar.version}`, "--silent"], { cwd: source, encoding: "utf8" }).trim();
    execFileSync("tar", ["-xzf", tarball, "--strip-components=1"], { cwd: source });

    const output = path.join(work, `${grammar.name}.wasm`);
    execFileSync(cli, ["build", "--wasm", "--output", output, path.join(source, grammar.dir)], { stdio: "inherit" });

    const target = path.join(outDir, `${grammar.name}.wasm`);
    await copyFile(output, target);
    const bytes = await readFile(target);
    manifest.grammars[grammar.name] = {
      package: grammar.package,
      version: grammar.version,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    };
    console.log(`${grammar.name}: ${grammar.package}@${grammar.version} (${bytes.length} bytes)`);
  }
} finally {
  await rm(work, { recursive: true, force: true });
}

const stale = (await readdir(outDir)).filter((file) => file.endsWith(".wasm") && !(file.replace(/\.wasm$/, "") in manifest.grammars));
for (const file of stale) await rm(path.join(outDir, file));
await writeFile(path.join(outDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

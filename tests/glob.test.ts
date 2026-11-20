import { nodeFileSystem } from "../src/adapters/fs/node-file-system.js";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { findWorkspacePackageJsons } from "../src/integrations/languages/js-ts/project.js";
import { createGlobMatcher, matchesGlob, walkFiles } from "../src/core/scan/glob.js";

// [pattern, path, expected]
const cases: Array<[string, string, boolean]> = [
  ["*", "a.ts", true],
  ["*", "a/b.ts", false],
  ["*", ".env", true],
  ["*.ts", "index.ts", true],
  ["*.ts", "index.tsx", false],
  ["*.ts", "src/index.ts", false],
  ["a*c", "abbbc", true],
  ["a*c", "ab/c", false],
  ["?.ts", "a.ts", true],
  ["?.ts", "ab.ts", false],
  ["?", "/", false],
  ["**", "a", true],
  ["**", "a/b/c.ts", true],
  ["**/*", "a.ts", true],
  ["**/*", "a/b/c.ts", true],
  ["**/*.ts", "a.ts", true],
  ["**/*.ts", "a/b/c.ts", true],
  ["**/*.ts", "a/b/c.js", false],
  ["src/**", "src/a.ts", true],
  ["src/**", "src/a/b.ts", true],
  ["src/**", "lib/a.ts", false],
  ["src/**/*.ts", "src/a.ts", true],
  ["src/**/*.ts", "src/a/b/c.ts", true],
  ["src/**/*.ts", "srcx/a.ts", false],
  ["a/**/b", "a/b", true],
  ["a/**/b", "a/x/y/b", true],
  ["a/**/b", "a/xb", false],
  ["a**b", "axxb", true],
  ["a**b", "ax/xb", false],
  ["**/.github/**", ".github/workflows/ci.yml", true],
  ["{a,b}.ts", "a.ts", true],
  ["{a,b}.ts", "b.ts", true],
  ["{a,b}.ts", "c.ts", false],
  ["*.{ts,tsx}", "x.tsx", true],
  ["src/{lib,app/{x,y}}/*.ts", "src/app/y/a.ts", true],
  ["src/{lib,app/{x,y}}/*.ts", "src/app/z/a.ts", false],
  ["{a", "{a", true],
  ["a}", "a}", true],
  ["[abc].ts", "b.ts", true],
  ["[abc].ts", "d.ts", false],
  ["[a-c].ts", "b.ts", true],
  ["[!a-c].ts", "d.ts", true],
  ["[!a-c].ts", "b.ts", false],
  ["[^a].ts", "b.ts", true],
  ["[!a]", "/", false],
  ["[]]", "]", true],
  ["[abc", "[abc", true],
  ["\\*.ts", "*.ts", true],
  ["\\*.ts", "a.ts", false],
  ["a\\{b,c}", "a{b,c}", true],
  ["a.b", "axb", false],
  ["(a|b)", "(a|b)", true],
  ["$^+", "$^+", true],
];

describe("glob matching", () => {
  for (const [pattern, file, expected] of cases) {
    it(`${pattern} ${expected ? "matches" : "does not match"} ${file}`, () => {
      assert.equal(matchesGlob(pattern, file), expected);
    });
  }

  it("treats braces literally when brace expansion is off", () => {
    assert.equal(matchesGlob("{a,b}", "a", { braces: false }), false);
    assert.equal(matchesGlob("{a,b}", "{a,b}", { braces: false }), true);
  });

  it("strips a leading ./ and reports the literal base directory", () => {
    assert.equal(createGlobMatcher("./src/**/*.ts").base, "src");
    assert.equal(createGlobMatcher("packages/*/package.json").base, "packages");
    assert.equal(createGlobMatcher("apps/web/package.json").base, "apps/web");
    assert.equal(createGlobMatcher("**/*.ts").base, "");
    assert.equal(createGlobMatcher("*.ts").base, "");
    assert.equal(createGlobMatcher("./src/a.ts").matches("src/a.ts"), true);
  });

  it("prunes directories that cannot contain a match", () => {
    const matcher = createGlobMatcher("packages/*/package.json");
    assert.equal(matcher.mayContain("packages"), true);
    assert.equal(matcher.mayContain("packages/api"), true);
    assert.equal(matcher.mayContain("packages/api/src"), false);
    assert.equal(matcher.mayContain("apps"), false);

    const deep = createGlobMatcher("src/**/*.ts");
    assert.equal(deep.mayContain("src/a/b/c"), true);
    assert.equal(deep.mayContain("lib"), false);
    assert.equal(createGlobMatcher("*.ts").mayContain("src"), false);
    // Braces spanning segments disable pruning rather than risk a wrong answer.
    assert.equal(createGlobMatcher("{a/b,c}/*.ts").mayContain("zzz"), true);
  });
});

describe("walkFiles", () => {
  async function tree(files: string[]): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-glob-"));
    for (const file of files) {
      await mkdir(path.join(root, path.dirname(file)), { recursive: true });
      await writeFile(path.join(root, file), "");
    }
    return root;
  }

  it("lists files as sorted POSIX paths, including dotfiles", async () => {
    const root = await tree(["b.ts", "a/c.ts", "a/.hidden", ".env", "a/b/d.ts"]);
    assert.deepEqual(await walkFiles(root, nodeFileSystem), [".env", "a/.hidden", "a/b/d.ts", "a/c.ts", "b.ts"]);
  });

  it("skips rejected directories without entering them", async () => {
    const root = await tree(["src/a.ts", "node_modules/x/index.js", "src/node_modules/y.js"]);
    const entered: string[] = [];
    const files = await walkFiles(root, nodeFileSystem, {
      enterDirectory: (directory) => { entered.push(directory); },
      accept: (relativePath, isDirectory) => !isDirectory || path.posix.basename(relativePath) !== "node_modules",
    });
    assert.deepEqual(files, ["src/a.ts"]);
    assert.deepEqual(entered.sort(), ["", "src"]);
  });

  it("starts from the given directories and ignores missing or nested ones", async () => {
    const root = await tree(["src/a.ts", "src/lib/b.ts", "lib/c.ts"]);
    assert.deepEqual(await walkFiles(root, nodeFileSystem, { start: ["src/lib", "src", "missing"] }), ["src/a.ts", "src/lib/b.ts"]);
  });

  it("lists symlinked files but does not follow symlinked directories", async () => {
    const root = await tree(["real/a.ts", "b.ts"]);
    await symlink(path.join(root, "b.ts"), path.join(root, "link.ts"));
    await symlink(path.join(root, "real"), path.join(root, "loop"));
    await symlink(path.join(root, "missing.ts"), path.join(root, "broken.ts"));
    assert.deepEqual(await walkFiles(root, nodeFileSystem), ["b.ts", "link.ts", "real/a.ts"]);
  });

  it("finds workspace package.json files without descending into node_modules or past the pattern depth", async () => {
    const root = await tree([
      "package.json",
      "packages/api/package.json",
      "packages/web/package.json",
      "packages/web/node_modules/dep/package.json",
      "packages/web/fixtures/nested/package.json",
      "apps/admin/package.json",
    ]);
    assert.deepEqual(await findWorkspacePackageJsons(root, "packages/*", nodeFileSystem), [
      "packages/api/package.json",
      "packages/web/package.json",
    ]);
    assert.deepEqual(await findWorkspacePackageJsons(root, "./apps/*/package.json", nodeFileSystem), ["apps/admin/package.json"]);
    assert.deepEqual(await findWorkspacePackageJsons(root, "packages/**", nodeFileSystem), [
      "packages/api/package.json",
      "packages/web/fixtures/nested/package.json",
      "packages/web/package.json",
    ]);
    assert.deepEqual(await findWorkspacePackageJsons(root, "!packages/web", nodeFileSystem), []);
  });
});

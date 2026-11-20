import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { defaultLanguageTable } from "../src/composition/default-registry.js";
import { discoverFiles } from "../src/core/scan/discover-files.js";
import { GitIgnore } from "../src/core/scan/gitignore.js";

// [rules, path, isDirectory, ignored] — modeled on git's t0008-ignores cases.
const cases: Array<[string, string, boolean, boolean]> = [
  ["foo", "foo", false, true],
  ["foo", "a/b/foo", false, true],
  ["foo", "a/b/foo", true, true],
  ["foo", "foobar", false, false],
  ["*.log", "debug.log", false, true],
  ["*.log", "logs/debug.log", false, true],
  ["*.log", "debug.log.txt", false, false],
  ["/foo", "foo", false, true],
  ["/foo", "a/foo", false, false],
  ["a/foo", "a/foo", false, true],
  ["a/foo", "x/a/foo", false, false],
  ["foo/", "foo", true, true],
  ["foo/", "foo", false, false],
  ["foo/", "a/foo", true, true],
  ["a/*/c", "a/b/c", false, true],
  ["a/*/c", "a/b/x/c", false, false],
  ["**/foo", "foo", false, true],
  ["**/foo", "a/b/foo", false, true],
  ["**/foo/bar", "a/foo/bar", false, true],
  ["a/**", "a/b", false, true],
  ["a/**", "a/b/c", false, true],
  // The directory itself stays; everything inside it is ignored (`git check-ignore a` agrees).
  ["a/**", "a", true, false],
  ["a/**/b", "a/b", false, true],
  ["a/**/b", "a/x/y/b", false, true],
  ["*.log\n!keep.log", "keep.log", false, false],
  ["*.log\n!keep.log", "other.log", false, true],
  ["!keep.log\n*.log", "keep.log", false, true],
  ["\\!important", "!important", false, true],
  ["\\#notes", "#notes", false, true],
  ["# comment", "# comment", false, false],
  ["foo   ", "foo", false, true],
  ["foo\\ ", "foo ", false, true],
  ["foo\r", "foo", false, true],
  ["", "anything", false, false],
  ["/", "anything", false, false],
  ["[abc].txt", "b.txt", false, true],
  ["[!abc].txt", "b.txt", false, false],
  ["?.txt", "a.txt", false, true],
  ["{a,b}", "a", false, false],
  ["{a,b}", "{a,b}", false, true],
];

describe("gitignore rules", () => {
  for (const [rules, file, isDirectory, expected] of cases) {
    it(`${JSON.stringify(rules)} ${expected ? "ignores" : "keeps"} ${file}${isDirectory ? "/" : ""}`, () => {
      assert.equal(new GitIgnore().add(rules).ignores(file, isDirectory), expected);
    });
  }

  it("applies nested rules relative to their directory, deeper rules winning", () => {
    const rules = new GitIgnore()
      .add("*.log\n/out", "")
      .add("!keep.log\n/local", "pkg");
    assert.equal(rules.ignores("pkg/keep.log", false), false);
    assert.equal(rules.ignores("keep.log", false), true);
    assert.equal(rules.ignores("pkg/other.log", false), true);
    assert.equal(rules.ignores("pkg/local", true), true);
    assert.equal(rules.ignores("local", true), false);
    assert.equal(rules.ignores("pkg/out", true), false);
    assert.equal(rules.ignores("out", true), true);
  });

  it("accepts a pattern list as well as file content", () => {
    const rules = new GitIgnore().add(["dist", "*.min.js"]);
    assert.equal(rules.ignores("dist", true), true);
    assert.equal(rules.ignores("a/b.min.js", false), true);
    assert.equal(rules.ignores("a/b.js", false), false);
  });
});

describe("discoverFiles", () => {
  async function tree(files: Record<string, string>): Promise<string> {
    const root = await mkdtemp(path.join(os.tmpdir(), "concentrate-discover-"));
    for (const [file, content] of Object.entries(files)) {
      await mkdir(path.join(root, path.dirname(file)), { recursive: true });
      await writeFile(path.join(root, file), content);
    }
    return root;
  }

  async function discover(root: string, options?: Parameters<typeof discoverFiles>[1]): Promise<string[]> {
    return (await discoverFiles(root, { conventions: defaultLanguageTable.conventions, ...options })).map((file) => path.relative(root, file).split(path.sep).join("/"));
  }

  it("respects nested .gitignore files", async () => {
    const root = await tree({
      ".gitignore": "*.log\n",
      "a.ts": "",
      "debug.log": "",
      "packages/api/.gitignore": "/generated\n!keep.log\n",
      "packages/api/src/index.ts": "",
      "packages/api/generated/client.ts": "",
      "packages/api/keep.log": "",
      "packages/web/generated/client.ts": "",
    });
    assert.deepEqual(await discover(root), [
      ".gitignore",
      "a.ts",
      "packages/api/.gitignore",
      "packages/api/keep.log",
      "packages/api/src/index.ts",
      "packages/web/generated/client.ts",
    ]);
  });

  it("cannot re-include a file inside an ignored directory", async () => {
    const root = await tree({ ".gitignore": "logs/\n!logs/keep.txt\n", "logs/keep.txt": "", "a.ts": "" });
    assert.deepEqual(await discover(root), [".gitignore", "a.ts"]);
  });

  it("skips default directories, applies excludes with gitignore semantics and includes as globs", async () => {
    const root = await tree({
      "node_modules/x/index.js": "",
      "src/app.ts": "",
      "src/app.spec.ts": "",
      "src/vendor.min.js": "",
      "src/legacy/old.ts": "",
      "dist/app.js": "",
      "README.md": "",
    });
    assert.deepEqual(await discover(root), ["README.md", "src/app.spec.ts", "src/app.ts", "src/legacy/old.ts"]);
    assert.deepEqual(await discover(root, { exclude: ["legacy/", "*.md"] }), ["src/app.spec.ts", "src/app.ts"]);
    assert.deepEqual(await discover(root, { include: ["src/**/*.ts", "!**/*.spec.ts"] }), ["src/app.ts", "src/legacy/old.ts"]);
  });
});

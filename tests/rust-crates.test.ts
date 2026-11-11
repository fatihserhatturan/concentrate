import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import { parseToml } from "../src/integrations/languages/rust/cargo.js";

const resolutions = async (fixture: string) => {
  const result = await buildCodeGraph(path.resolve("fixtures", fixture), { continueOnError: true, concurrency: 2 });
  const importFile = new Map<string, string>();
  for (const relationship of result.relationships) {
    if (relationship.type === "RESOLVES_TO") importFile.set(relationship.from.replace(/^file:/u, ""), relationship.to.replace(/^file:/u, ""));
  }
  return { result, resolved: (importId: string) => importFile.get(importId) };
};

describe("Cargo.toml reader", () => {
  it("reads tables, dotted keys, inline tables and multi-line arrays", () => {
    const toml = parseToml(`
# comment
[workspace]
members = [
  "crates/*", # trailing
  "tools/x",
]

[dependencies]
serde = "1"
my-core.workspace = true
other = { path = "../other", package = "real-name" }

[[bin]]
name = "a"
path = "src/bin/a.rs"
`);
    assert.deepEqual((toml.workspace as { members: string[] }).members, ["crates/*", "tools/x"]);
    const dependencies = toml.dependencies as Record<string, unknown>;
    assert.equal(dependencies.serde, "1");
    assert.deepEqual(dependencies["my-core"], { workspace: true });
    assert.deepEqual(dependencies.other, { path: "../other", package: "real-name" });
    assert.deepEqual(toml.bin, [{ name: "a", path: "src/bin/a.rs" }]);
  });
});

describe("Rust crates and modules", () => {
  it("resolves use paths across a Cargo workspace", async () => {
    const { resolved } = await resolutions("rust-workspace");
    const app = "crates/app/src/main.rs:import";
    const core = "crates/my-core/src";
    // Crate names with `-` become `_`; `package = ` renames; groups and aliases are split.
    assert.equal(resolved(`${app}:4:my_core::store::memory`), `${core}/store/memory.rs`);
    assert.equal(resolved(`${app}:4:my_core::net::client::connect`), `${core}/net/client.rs`);
    assert.equal(resolved(`${app}:5:core_alias::util::shout`), `${core}/util.rs`);
    // A `pub use` re-export of an item points at the file that defines it.
    assert.equal(resolved(`${app}:4:my_core::InMemory`), `${core}/store/memory.rs`);
    // A glob over an inline module resolves to the file holding it.
    assert.equal(resolved(`${app}:3:my_core::prelude`), `${core}/lib.rs`);
    // External crates and std are not resolved.
    assert.equal(resolved(`${app}:7:serde::Serialize`), undefined);
    assert.equal(resolved(`${app}:8:std::collections::HashMap`), undefined);
  });

  it("follows mod.rs, foo.rs + foo/, #[path] and inline modules", async () => {
    const { resolved } = await resolutions("rust-workspace");
    const lib = "crates/my-core/src/lib.rs:import";
    assert.equal(resolved(`${lib}:1:store`), "crates/my-core/src/store/mod.rs");
    assert.equal(resolved(`${lib}:2:net`), "crates/my-core/src/net.rs");
    assert.equal(resolved("crates/my-core/src/net.rs:import:1:client"), "crates/my-core/src/net/client.rs");
    assert.equal(resolved(`${lib}:5:old_helpers`), "crates/my-core/src/legacy/old_helpers.rs");
    assert.equal(resolved(`${lib}:16:deep`), "crates/my-core/src/inline/deep.rs");
    // self / super inside inline modules, a crate-relative path in a nested file.
    assert.equal(resolved("crates/my-core/src/store/memory.rs:import:1:super::Repo"), "crates/my-core/src/store/mod.rs");
    assert.equal(resolved("crates/my-core/src/net/client.rs:import:8:super::super::Connection"), "crates/my-core/src/net/client.rs");
  });

  it("keeps the rest of a file with a syntax error and warns", async () => {
    const { result } = await resolutions("rust-syntax-error");
    assert.ok(result.report.warnings.some((warning) => warning.path === "src/lib.rs" && warning.message.startsWith("Syntax error")));
    assert.equal(result.report.failedFiles.length, 0);
    const names = result.nodes.filter((node) => node.label === "Function" || node.label === "Class").map((node) => node.properties.name);
    for (const name of ["before", "After", "kept"]) assert.ok(names.includes(name), name);
    assert.ok(!names.includes("broken"));
  });
});

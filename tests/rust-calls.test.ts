import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

// Every call of fixtures/rust-calls as `file:line expression` → resolved
// targets (`file#name`, `(trait)` for a marked one).
let targets: Map<string, string[]>;
const at = (key: string) => (targets.get(key) ?? []).slice().sort();

describe("Rust call resolution", () => {
  before(async () => {
    const result = await buildCodeGraph(path.resolve("fixtures/rust-calls"), { continueOnError: true, concurrency: 2 });
    const byId = new Map(result.nodes.map((node) => [node.id, node]));
    const resolved = new Map<string, string[]>();
    for (const relationship of result.relationships) {
      if (relationship.type !== "CALL_RESOLVES_TO") continue;
      const target = byId.get(relationship.to)!;
      const file = relationship.to.replace(/^file:/u, "").split(":function:")[0];
      const via = relationship.properties.via ? "(trait)" : "";
      resolved.set(relationship.from, [...resolved.get(relationship.from) ?? [], `${file}#${target.properties.className ? `${target.properties.className}.` : ""}${target.properties.name}${via}`]);
    }
    targets = new Map();
    for (const node of result.nodes) {
      if (node.label !== "Call") continue;
      const owner = result.relationships.find((relationship) => relationship.type === "CALLS" && relationship.to === node.id)!.from.split(":function:")[0]!.replace(/^file:/u, "");
      targets.set(`${owner}:${node.properties.line} ${node.properties.expression}`, resolved.get(node.id) ?? []);
    }
  });

  it("resolves module paths, aliases and crate:: paths", () => {
    assert.deepEqual(at("src/main.rs:25 h::shout"), ["src/util/helpers.rs#shout"]);
    assert.deepEqual(at("src/main.rs:26 util::helpers::whisper"), ["src/util/helpers.rs#whisper"]);
    assert.deepEqual(at("src/main.rs:27 crate::util::helpers::whisper"), ["src/util/helpers.rs#whisper"]);
    assert.deepEqual(at("src/main.rs:51 repo::connect"), ["src/services/repo.rs#connect"]);
    assert.deepEqual(at("src/models/user.rs:19 crate::util::helpers::shout"), ["src/util/helpers.rs#shout"]);
    assert.deepEqual(at("src/main.rs:62 broadcast"), ["src/main.rs#broadcast"]);
  });

  it("resolves Type::new(), Type::method() and Self::method()", () => {
    assert.deepEqual(at("src/main.rs:48 App::new"), ["src/main.rs#App.new"]);
    assert.deepEqual(at("src/main.rs:49 User::new"), ["src/models/user.rs#User.new"]);
    assert.deepEqual(at("src/main.rs:17 SqlRepo::open"), ["src/services/repo.rs#SqlRepo.open"]);
    assert.deepEqual(at("src/main.rs:24 Self::log"), ["src/main.rs#App.log"]);
    assert.deepEqual(at("src/models/user.rs:11 Self::new"), ["src/models/user.rs#User.new"]);
    assert.deepEqual(at("src/main.rs:61 Kind::default_label"), ["src/models/mod.rs#Kind.default_label"]);
  });

  it("resolves Trait::method() and qualified paths to every implementation, marked", () => {
    assert.deepEqual(at("src/main.rs:57 Repo::find"), ["src/services/repo.rs#SqlRepo.find(trait)"]);
    assert.deepEqual(at("src/main.rs:58 Repo::find"), ["src/services/repo.rs#SqlRepo.find(trait)"]);
  });

  it("resolves method calls on typed receivers", () => {
    // `&User` parameter, `let x = User::new()`-style constructors, `?`/unwrap, struct literals.
    assert.deepEqual(at("src/main.rs:31 user.greet"), ["src/models/user.rs#User.greet"]);
    assert.deepEqual(at("src/main.rs:53 app.run"), ["src/main.rs#App.run"]);
    assert.deepEqual(at("src/main.rs:54 made.greet"), ["src/models/user.rs#User.greet"]);
    assert.deepEqual(at("src/main.rs:55 by_literal.greet"), ["src/models/user.rs#User.greet"]);
    assert.deepEqual(at("src/main.rs:56 repo.find"), ["src/services/repo.rs#SqlRepo.find"]);
    // An enum value from its variant constructor.
    assert.deepEqual(at("src/main.rs:60 kind.label"), ["src/models/mod.rs#Kind.label"]);
  });

  it("resolves self, self fields and default trait methods", () => {
    assert.deepEqual(at("src/main.rs:22 self.notify_all"), ["src/main.rs#App.notify_all"]);
    assert.deepEqual(at("src/main.rs:21 self.repo.find"), ["src/services/repo.rs#SqlRepo.find"]);
    assert.deepEqual(at("src/models/user.rs:15 self.shout_name"), ["src/models/user.rs#User.shout_name"]);
    // `count` is the default method of Repo, called on SqlRepo.
    assert.equal(at("src/services/repo.rs:20 self.count").length, 1);
  });

  it("sends trait-object and bounded-generic calls to every implementation, marked", () => {
    const send = ["src/services/notifier.rs#Email.send(trait)", "src/services/notifier.rs#Sms.send(trait)"];
    assert.deepEqual(at("src/main.rs:23 self.notifier.send"), send);
    assert.deepEqual(at("src/main.rs:44 n.send"), send);
    assert.deepEqual(at("src/main.rs:40 n.send"), send);
  });

  it("resolves macro_rules calls and leaves std, closures and unknown names unresolved", () => {
    assert.deepEqual(at("src/main.rs:67 square!"), ["src/main.rs#square"]);
    for (const key of ["src/main.rs:17 Box::new", "src/main.rs:64 closure", "src/main.rs:65 unknown_fn", "src/main.rs:66 Vec::new", "src/main.rs:52 String::new"]) {
      assert.deepEqual(at(key), [], key);
    }
  });
});

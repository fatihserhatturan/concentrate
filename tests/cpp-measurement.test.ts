import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

async function project(files: Record<string, string>): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "cpp-measurement-"));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(directory, name)), { recursive: true });
    await writeFile(path.join(directory, name), text);
  }
  return directory;
}

describe("C++ measurement fixes (Phase 37)", () => {
  it("links a client call to the route of its own program when several programs register the same path", async () => {
    const program = (host: string) => `#include "httplib.h"
int main() {
  httplib::Server svr;
  svr.Get("/hi", [](const httplib::Request &, httplib::Response &res) { res.set_content("hi", "text/plain"); });
  httplib::Client cli("${host}", 8080);
  auto res = cli.Get("/hi");
}
`;
    const root = await project({ "example/a.cc": program("localhost"), "example/b.cc": program("127.0.0.1") });
    const graph = await buildCodeGraph(root, { continueOnError: false });
    const requests = graph.relationships.filter((rel) => rel.type === "REQUESTS").map((rel) => `${rel.from.split(":function")[0]} -> ${rel.to.split(":route")[0]}`).sort();
    assert.deepEqual(requests, ["file:example/a.cc -> file:example/a.cc", "file:example/b.cc -> file:example/b.cc"]);
  });

  it("reads the variable name of a namespaced GetEnv wrapper", async () => {
    const root = await project({
      "src/flags.cc": `namespace internal { namespace posix { const char *GetEnv(const char *name); } }
const char *Filter() { return internal::posix::GetEnv("TESTBRIDGE_TEST_ONLY"); }
`,
    });
    const graph = await buildCodeGraph(root, { continueOnError: false });
    assert.deepEqual(graph.nodes.filter((node) => node.label === "EnvVar").map((node) => node.properties.name), ["TESTBRIDGE_TEST_ONLY"]);
  });

  it("keeps the functions after a GTEST_DEFINE_ flag with a prefix and a trailing underscore", async () => {
    const root = await project({
      "src/flags.cc": `GTEST_DEFINE_string_(
    filter, testing::internal::StringFromGTestEnv("filter", "a;b"),
    "A list; with \\"quotes\\"")

int after() { return 1; }
`,
    });
    const graph = await buildCodeGraph(root, { continueOnError: false });
    assert.ok(graph.nodes.some((node) => node.label === "Function" && node.properties.name === "after"));
  });
});

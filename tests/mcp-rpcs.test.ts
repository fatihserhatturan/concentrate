import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { callMcpTool } from "../src/adapters/mcp/tools.js";
import { GraphStore } from "../src/adapters/store/store.js";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

describe("proto rpcs in list_rpcs", () => {
  let store: GraphStore;
  let root: string;
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "concentrate-mcp-rpcs-"));
    const graph = await buildCodeGraph(path.resolve("fixtures/proto-services"), { continueOnError: false });
    store = await GraphStore.open(path.join(root, "graph"));
    await store.reset();
    await store.write(graph.nodes, graph.relationships);
  });
  after(async () => {
    await store.close();
    await rm(root, { recursive: true, force: true });
  });
  const call = async (args: Record<string, unknown>): Promise<Record<string, any>> =>
    JSON.parse((await callMcpTool(store, "list_rpcs", args)).content[0]!.text) as Record<string, any>;

  it("lists an rpc with its messages, the generated server interface and every implementation", async () => {
    const result = await call({ name: "user.v1.User/Save" });
    assert.equal(result.totalRpcs, 1);
    const [save] = result.rpcs;
    assert.deepEqual([save.service, save.name, save.file, save.request, save.response, save.streaming ?? null], ["user.v1.User", "Save", "proto/user/v1/user.proto", "SaveReq", "SaveReply", null]);
    assert.deepEqual(save.requestMessage, { message: "user.v1.SaveReq", file: "proto/user/v1/user.proto", line: 9 });
    assert.deepEqual([save.servedBy.interface, save.servedBy.file], ["UserServer", "gen/user/v1/user_grpc.pb.go"]);
    assert.deepEqual(save.implementations.map((impl: any) => `${impl.file}#${impl.name}`), ["internal/admin/service.go#Service.Save", "internal/user/service.go#Service.Save"]);
  });

  it("marks streams, and an rpc with no generated Go code has no servedBy", async () => {
    const watch = (await call({ name: "Watch" })).rpcs[0];
    assert.equal(watch.streaming, "server");
    const daily = (await call({ name: "Reports" })).rpcs[0];
    assert.equal(daily.servedBy, null);
    assert.deepEqual(daily.implementations, []);
  });

  it("filters by file", async () => {
    const result = await call({ file: "proto/billing/" });
    assert.deepEqual(result.rpcs.map((rpc: any) => `${rpc.service}/${rpc.name}`), ["billing.v1.Billing/Audit", "billing.v1.Billing/Charge", "billing.v1.Billing/Refund", "billing.v1.Reports/Daily"]);
  });
});

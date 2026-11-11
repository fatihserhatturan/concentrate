import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode } from "../src/core/graph/model.js";

describe("proto services in the graph", () => {
  let graph: Awaited<ReturnType<typeof buildCodeGraph>>;
  let byId: Map<string, GraphNode>;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/proto-services"), { continueOnError: false });
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
  });
  const label = (id: string): string => {
    const node = byId.get(id)!;
    if (node.label === "Rpc") return `${node.properties.service}/${node.properties.name}`;
    if (node.label === "Function") return `${id.replace(/^file:/u, "").split(":")[0]}#${node.properties.className ?? ""}.${node.properties.name}`;
    if (node.label === "File") return String(node.properties.relativePath);
    return String(node.properties.fullName ?? node.properties.name);
  };
  const edges = (type: string) => graph.relationships.filter((rel) => rel.type === type).map((rel) => `${label(rel.from)} -> ${label(rel.to)}`).sort();

  it("declares services, rpcs and messages with package, line and streaming", () => {
    assert.deepEqual(edges("DECLARES_SERVICE"), ["proto/billing/v1/billing.proto -> billing.v1.Billing", "proto/billing/v1/billing.proto -> billing.v1.Reports", "proto/user/v1/user.proto -> user.v1.User"]);
    assert.deepEqual(edges("DECLARES_MESSAGE"), [
      "proto/billing/v1/billing.proto -> billing.v1.ChargeReply",
      "proto/billing/v1/billing.proto -> billing.v1.ChargeReq",
      "proto/user/v1/user.proto -> user.v1.Profile",
      "proto/user/v1/user.proto -> user.v1.SaveReply",
      "proto/user/v1/user.proto -> user.v1.SaveReq",
    ]);
    const rpcs = graph.nodes.filter((node) => node.label === "Rpc").map((node) => `${node.properties.service}/${node.properties.name}@${node.properties.line}${node.properties.clientStreaming ? " client-stream" : ""}${node.properties.serverStreaming ? " server-stream" : ""}`).sort();
    assert.deepEqual(rpcs, [
      "billing.v1.Billing/Audit@19", "billing.v1.Billing/Charge@17", "billing.v1.Billing/Refund@18 client-stream",
      "billing.v1.Reports/Daily@24",
      "user.v1.User/Get@25", "user.v1.User/Ping@29", "user.v1.User/Save@24", "user.v1.User/Watch@28 server-stream",
    ]);
    assert.deepEqual(edges("HAS_RPC").length, 8);
  });

  it("resolves request and response messages by package scope, qualified and leading-dot names; library types stay unlinked", () => {
    assert.deepEqual(edges("RPC_REQUEST"), [
      "billing.v1.Billing/Audit -> user.v1.SaveReq",
      "billing.v1.Billing/Charge -> billing.v1.ChargeReq",
      "billing.v1.Billing/Refund -> billing.v1.ChargeReq",
      "billing.v1.Reports/Daily -> billing.v1.ChargeReq",
      "user.v1.User/Get -> user.v1.SaveReq",
      "user.v1.User/Save -> user.v1.SaveReq",
      "user.v1.User/Watch -> user.v1.SaveReq",
    ]);
    assert.deepEqual(edges("RPC_RESPONSE").filter((edge) => edge.startsWith("user.v1.User/")), [
      "user.v1.User/Get -> user.v1.Profile",
      "user.v1.User/Save -> user.v1.SaveReply",
      "user.v1.User/Watch -> user.v1.SaveReply",
    ]);
  });

  it("links an rpc to the generated server interface and to every implementation, not to the Unimplemented stub", () => {
    assert.deepEqual(edges("RPC_SERVED_BY"), [
      "billing.v1.Billing/Audit -> BillingServer", "billing.v1.Billing/Charge -> BillingServer", "billing.v1.Billing/Refund -> BillingServer",
      "user.v1.User/Get -> UserServer", "user.v1.User/Ping -> UserServer", "user.v1.User/Save -> UserServer", "user.v1.User/Watch -> UserServer",
    ]);
    assert.deepEqual(edges("RPC_IMPLEMENTED_BY"), [
      "billing.v1.Billing/Audit -> internal/billing/service.go#Service.Audit",
      "billing.v1.Billing/Charge -> internal/billing/service.go#Service.Charge",
      "billing.v1.Billing/Refund -> internal/billing/service.go#Service.Refund",
      "user.v1.User/Get -> internal/admin/service.go#Service.Get",
      "user.v1.User/Get -> internal/user/service.go#Service.Get",
      "user.v1.User/Ping -> internal/user/service.go#Service.Ping",
      "user.v1.User/Save -> internal/admin/service.go#Service.Save",
      "user.v1.User/Save -> internal/user/service.go#Service.Save",
      "user.v1.User/Watch -> internal/user/service.go#Service.Watch",
    ]);
    // billing.v1.Reports has no generated Go code in the scan.
    assert.ok(!edges("RPC_SERVED_BY").some((edge) => edge.includes("Reports")));
  });

  it("resolves proto imports to files of the project, from the scan root or the importer, and leaves well-known ones", () => {
    const imports = graph.nodes.filter((node) => node.label === "Import" && String(node.properties.specifier).startsWith("import "))
      .map((node) => `${node.properties.source} -> ${graph.relationships.filter((rel) => rel.type === "RESOLVES_TO" && rel.from === node.id).map((rel) => label(rel.to)).join(",") || "-"}`).sort();
    assert.deepEqual(imports, ["google/protobuf/empty.proto -> -", "user/v1/user.proto -> proto/user/v1/user.proto"]);
  });

  it("leaves no transient data and keeps the Go gRPC links", () => {
    assert.ok(graph.nodes.every((node) => node.properties.goGrpcServices === undefined));
  });
});

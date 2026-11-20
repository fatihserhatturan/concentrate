import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

describe("gRPC Java (fixtures/java-grpc)", () => {
  let graph: Graph;
  let byId: Map<string, GraphNode>;
  const label = (id: string) => String(byId.get(id)!.properties.qualifiedName).replace(/^com\.acme\./u, "");
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/java-grpc"), { continueOnError: false, keepCallSites: true });
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
  });

  it("makes an EntryPoint of each rpc of a class extending the generated ImplBase", () => {
    const entries = graph.nodes
      .filter((node) => node.label === "EntryPoint")
      .map((entry) => {
        const handler = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === entry.id)!.to;
        return `${String(entry.properties.kind)} ${String(entry.properties.library)} ${String(entry.properties.trigger)} -> ${label(handler)}`;
      })
      .sort();
    // UserGrpc is in the scan: `describe`, the package-private and the static method are no rpcs.
    // BillingGrpc is not: the gRPC signatures decide (a unary, a bidi stream; not `refund`, private, static).
    assert.deepEqual(entries, [
      "grpc grpc-java Billing/batch -> billing.BillingService.batch",
      "grpc grpc-java Billing/charge -> billing.BillingService.charge",
      "grpc grpc-java Report/generate -> billing.ReportService.generate",
      "grpc grpc-java User/chat -> user.UserService.chat",
      "grpc grpc-java User/get -> user.FakeUserService.get",
      "grpc grpc-java User/get -> user.UserService.get",
      "grpc grpc-java User/save -> user.UserService.save",
      "grpc grpc-java User/watch -> user.UserService.watch",
    ]);
  });

  it("links stub calls to every implementing method, however the stub is held", () => {
    const owner = new Map(graph.relationships.filter((rel) => rel.type === "CALLS").map((rel) => [rel.to, rel.from]));
    const links = graph.relationships
      .filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.properties.via === "grpc")
      .map((rel) => {
        const call = byId.get(rel.from)!;
        return `${label(owner.get(rel.from)!)}:${String(call.properties.line)} ${String(call.properties.callee)} -> ${label(rel.to)}`;
      })
      .sort();
    assert.deepEqual(links, [
      // a typed field, `this.field`, a future and an async stub, a stub of a service whose generated class is not scanned
      "client.UserClient.fields:27 get -> user.FakeUserService.get",
      "client.UserClient.fields:27 get -> user.UserService.get",
      "client.UserClient.fields:28 save -> user.UserService.save",
      "client.UserClient.fields:29 get -> user.FakeUserService.get",
      "client.UserClient.fields:29 get -> user.UserService.get",
      "client.UserClient.fields:30 chat -> user.UserService.chat",
      "client.UserClient.fields:31 charge -> billing.BillingService.charge",
      // var of newBlockingStub, a stub made in place, a typed local
      "client.UserClient.made:45 get -> user.FakeUserService.get",
      "client.UserClient.made:45 get -> user.UserService.get",
      "client.UserClient.made:46 save -> user.UserService.save",
      "client.UserClient.made:48 get -> user.FakeUserService.get",
      "client.UserClient.made:48 get -> user.UserService.get",
      // a parameter
      "client.UserClient.parameter:40 watch -> user.UserService.watch",
      // through withDeadlineAfter
      "client.UserClient.withDeadline:36 get -> user.FakeUserService.get",
      "client.UserClient.withDeadline:36 get -> user.UserService.get",
    ]);
  });

  it("links the .proto rpcs to the implementations", () => {
    const links = graph.relationships
      .filter((rel) => rel.type === "RPC_IMPLEMENTED_BY")
      .map((rel) => `${String(byId.get(rel.from)!.properties.name)} -> ${label(rel.to)}`)
      .sort();
    assert.deepEqual(links, ["Chat -> user.UserService.chat", "Get -> user.FakeUserService.get", "Get -> user.UserService.get", "Save -> user.UserService.save", "Watch -> user.UserService.watch"]);
  });

  it("leaves no parse-time property behind and never links a Map.get", () => {
    assert.ok(graph.nodes.every((node) => !("javaGrpcStubs" in node.properties)));
    const unrelated = graph.nodes.filter((node) => node.label === "Call" && /^(other|cache)\.get$/u.test(String(node.properties.expression)));
    assert.equal(unrelated.length, 2);
    for (const call of unrelated) assert.ok(!graph.relationships.some((rel) => rel.from === call.id && rel.properties.via === "grpc"));
  });
});

describe("gRPC Java: abstract services", () => {
  it("makes no EntryPoint of an abstract class extending the generated base, only of the concrete one", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "grpc-abstract-"));
    try {
      await writeFile(path.join(root, "UserGrpc.java"), `package g;
public final class UserGrpc { public static abstract class UserImplBase { public void get(Req r, io.grpc.stub.StreamObserver<Resp> o) {} } }`);
      await writeFile(path.join(root, "S.java"), `package g;
import io.grpc.stub.StreamObserver;
public abstract class S extends UserGrpc.UserImplBase { @Override public void get(Req r, StreamObserver<Resp> o) {} }
class U extends UserGrpc.UserImplBase { @Override public void get(Req r, StreamObserver<Resp> o) {} }`);
      const graph = await buildCodeGraph(root, { continueOnError: false });
      const entries = graph.relationships
        .filter((rel) => rel.type === "ENTRYPOINT_HANDLED_BY")
        .map((rel) => String(graph.nodes.find((node) => node.id === rel.to)!.properties.qualifiedName));
      assert.deepEqual(entries, ["g.U.get"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

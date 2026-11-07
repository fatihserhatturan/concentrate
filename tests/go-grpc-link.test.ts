import assert from "node:assert/strict";
import path from "node:path";
import { before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

type Graph = { nodes: GraphNode[]; relationships: GraphRelationship[] };

const label = (node: GraphNode | undefined) => (node?.properties.className ? `${node.properties.className}.${node.properties.name}` : String(node?.properties.name));

describe("Go gRPC between services", () => {
  let graph: Graph;
  let byId: Map<string, GraphNode>;
  before(async () => {
    graph = await buildCodeGraph(path.resolve("fixtures/go-grpc-link"), { continueOnError: false });
    byId = new Map(graph.nodes.map((node) => [node.id, node]));
  });

  it("resolves the generated client's Invoke and NewStream to the service's method", () => {
    const owner = new Map(graph.relationships.filter((rel) => rel.type === "CALLS").map((rel) => [rel.to, rel.from]));
    const links = graph.relationships
      .filter((rel) => rel.type === "CALL_RESOLVES_TO" && rel.properties.via === "grpc")
      .map((rel) => `${label(byId.get(owner.get(rel.from)!))} -> ${label(byId.get(rel.to))}`)
      .sort();
    // A method-name constant, a literal and a stream; the Unimplemented stub is not a target.
    assert.deepEqual(links, ["userClient.Get -> UserService.Get", "userClient.Save -> UserService.Save", "userClient.Watch -> UserService.Watch"]);
    assert.ok(graph.nodes.every((node) => !("grpcMethod" in node.properties) && !("goGrpcServices" in node.properties)));
  });

  it("classifies a file with Go's generated header as generated", () => {
    const files = graph.nodes.filter((node) => node.label === "File" && node.properties.language === "go").map((node) => [node.properties.relativePath, node.properties.sourceType]).sort();
    assert.deepEqual(files, [["api/user/v1/user_grpc.pb.go", "generated"], ["gateway/gateway.go", "production"], ["user/service.go", "production"]]);
  });

  it("does not make a client built in another package inject the provider's parameters", () => {
    const injects = graph.relationships
      .filter((rel) => rel.type === "INJECTS")
      .map((rel) => `${label(byId.get(rel.from))} -> ${label(byId.get(rel.to))} ${rel.properties.fieldName}`);
    assert.deepEqual(injects, ["Gateway -> userClient uc"]);
  });
});

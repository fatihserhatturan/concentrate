import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";
import type { GraphNode, GraphRelationship } from "../src/core/graph/model.js";

// Member (nested) classes hang off the File like top-level ones (File -DEFINES_CLASS-> Outer.Inner), so
// the Java framework contributors see their methods: routes, gRPC services, DI providers, picocli commands.
const SOURCES: Record<string, string> = {
  "src/main/java/app/Server.java": `package app;

import io.grpc.stub.StreamObserver;
import org.springframework.stereotype.Service;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import picocli.CommandLine.Command;
import app.gen.EchoGrpc;

public class Server {
  @RestController
  @RequestMapping("/nested")
  public static class Api {
    private final Store store;
    public Api(Store store) { this.store = store; }
    @GetMapping("/items")
    public String items() { return store.read(); }

    // A class nested one level deeper still resolves to the file.
    @RestController
    @RequestMapping("/deep")
    public static class Deeper {
      @GetMapping("/x")
      public String x() { return ""; }
    }
  }

  @Service
  public static class Store {
    public String read() { return ""; }
  }

  public static class EchoImpl extends EchoGrpc.EchoImplBase {
    @Override
    public void say(Object request, StreamObserver<Object> observer) {}
  }

  @Command(name = "sub")
  public static class Sub implements Runnable {
    public void run() {}
  }
}
`,
};

describe("nested Java classes", () => {
  let root: string;
  let nodes: GraphNode[];
  let relationships: GraphRelationship[];
  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-nested-"));
    for (const [file, source] of Object.entries(SOURCES)) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), source);
    }
    ({ nodes, relationships } = await buildCodeGraph(root, { continueOnError: false }));
  });
  after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const handlerOf = (relation: "ROUTE_HANDLED_BY" | "ENTRYPOINT_HANDLED_BY", from: string): string =>
    String(nodes.find((node) => node.id === relationships.find((rel) => rel.type === relation && rel.from === from)!.to)!.properties.qualifiedName);

  it("finds routes of static nested and doubly nested controllers", () => {
    const routes = nodes
      .filter((node) => node.label === "Route")
      .map((route) => `${String(route.properties.framework)} ${String(route.properties.method)} ${String(route.properties.path)} ${handlerOf("ROUTE_HANDLED_BY", route.id)}`)
      .sort();
    assert.deepEqual(routes, ["spring-mvc GET /deep/x app.Server.Api.Deeper.x", "spring-mvc GET /nested/items app.Server.Api.items"]);
  });

  it("finds the gRPC rpc and the picocli command of nested classes", () => {
    const entries = nodes
      .filter((node) => node.label === "EntryPoint")
      .map((entry) => `${String(entry.properties.kind)} ${String(entry.properties.trigger)} ${handlerOf("ENTRYPOINT_HANDLED_BY", entry.id)}`)
      .sort();
    assert.deepEqual(entries, ["cli sub app.Server.Sub.run", "grpc Echo/say app.Server.EchoImpl.say"]);
  });

  it("makes a nested @Service a DI provider and injects it into a nested controller", () => {
    const store = nodes.find((node) => node.label === "Class" && node.properties.qualifiedName === "app.Server.Store")!;
    assert.equal(store.properties.diStereotype, "Service");
    const api = nodes.find((node) => node.label === "Class" && node.properties.qualifiedName === "app.Server.Api")!;
    assert.ok(relationships.some((rel) => rel.type === "INJECTS" && rel.from === api.id && rel.to === store.id));
  });
});

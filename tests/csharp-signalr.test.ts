import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

describe("SignalR (fixtures/csharp-signalr)", () => {
  it("makes an EntryPoint of each invocable hub method with the MapHub path", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-signalr"), { continueOnError: false });
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    const entries = graph.nodes
      .filter((node) => node.label === "EntryPoint" && node.properties.kind === "signalr")
      .map((entry) => {
        const handler = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === entry.id)!.to;
        return `${String(entry.properties.library)} ${String(entry.properties.trigger)} ${String(entry.properties.hubPath)} -> ${String(byId.get(handler)!.properties.qualifiedName).replace("Acme.Chat.Hubs.", "")}`;
      })
      .sort();
    assert.deepEqual(entries, [
      "signalr ChatHub/Counter /hubs/chat -> ChatHub.Counter",
      "signalr ChatHub/Ping /hubs/chat -> AuditedHub.Ping",
      "signalr ChatHub/SendMessage /hubs/chat -> ChatHub.SendMessage",
      "signalr ChatHub/join /hubs/chat -> ChatHub.JoinRoom",
      "signalr DraftHub/Draft null -> DraftHub.Draft",
      "signalr NotificationHub/Subscribe /hubs/notifications -> NotificationHub.Subscribe",
      "signalr NotificationHub/Unsubscribe /hubs/notifications -> NotificationHub.Unsubscribe",
    ]);
  });

  it("removes the parse-time MapHub property from the graph", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/csharp-signalr"), { continueOnError: false });
    assert.equal(graph.nodes.some((node) => "signalrMapHub" in node.properties), false);
  });
});

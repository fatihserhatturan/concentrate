import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { buildCodeGraph } from "../src/composition/orchestrator.js";

type Graph = Awaited<ReturnType<typeof buildCodeGraph>>;

// "<class>.<handler> <kind> <library> <trigger> <resolved>" for every EntryPoint but `main`.
function entries(graph: Graph): string[] {
  return graph.nodes
    .filter((node) => node.label === "EntryPoint" && node.properties.kind !== "main")
    .map((entry) => {
      const handlerId = graph.relationships.find((rel) => rel.type === "ENTRYPOINT_HANDLED_BY" && rel.from === entry.id)!.to;
      const handler = graph.nodes.find((node) => node.id === handlerId)!;
      const { kind, library, trigger, resolved } = entry.properties;
      return `${handler.properties.qualifiedName} ${kind} ${library} ${trigger} ${resolved}`;
    })
    .sort();
}

describe("Spring entrypoints (fixtures/java-spring-entrypoints)", () => {
  it("finds the application, scheduled methods and listeners, and nothing of the user's own annotations", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/java-spring-entrypoints"), { continueOnError: false });
    assert.deepEqual(entries(graph), [
      "com.acme.app.Application.main spring-boot-application spring-boot com.acme.app.Application true",
      "com.acme.app.Jobs.afterOneSecond scheduler spring fixedDelay=1000 true",
      "com.acme.app.Jobs.everyFiveSeconds scheduler spring fixedRate=5000 true",
      "com.acme.app.Jobs.everyMinute scheduler spring cron=0 * * * * * true",
      "com.acme.app.Jobs.nightly scheduler spring cron=NIGHTLY false",
      "com.acme.app.Listeners.afterCommit event spring OrderPlaced true",
      "com.acme.app.Listeners.onAlert queue spring-jms alerts true",
      "com.acme.app.Listeners.onAorB queue spring-kafka a true",
      "com.acme.app.Listeners.onAorB queue spring-kafka b true",
      "com.acme.app.Listeners.onMail queue spring-amqp mail true",
      "com.acme.app.Listeners.onOrder queue spring-kafka ORDERS false",
      "com.acme.app.Listeners.onPayment queue spring-kafka payments true",
      "com.acme.app.Listeners.onShipped event spring OrderShipped true",
      "com.acme.app.Listeners.onStarted event spring OrderPlaced true",
      "com.acme.app.MicronautJobs.tick scheduler micronaut fixedRate=10s true",
    ]);
  });

  it("makes the application RUN its main entrypoint, and skips an application without main", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/java-spring-entrypoints"), { continueOnError: false });
    const app = graph.nodes.find((node) => node.label === "EntryPoint" && node.properties.kind === "spring-boot-application")!;
    const runs = graph.relationships.filter((rel) => rel.type === "RUNS" && rel.from === app.id);
    assert.equal(runs.length, 1);
    assert.equal(graph.nodes.find((node) => node.id === runs[0]!.to)!.properties.kind, "main");
    assert.equal(graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.kind === "spring-boot-application").length, 1);
  });

  it("keeps the shape of the other entrypoints (declared by the file, handled by the method)", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/java-spring-entrypoints"), { continueOnError: false });
    const entry = graph.nodes.find((node) => node.label === "EntryPoint" && node.properties.kind === "scheduler" && node.properties.trigger === "cron=0 * * * * *")!;
    assert.deepEqual(entry.properties, { kind: "scheduler", trigger: "cron=0 * * * * *", receiverName: null, library: "spring", line: entry.properties.line, handlerName: "everyMinute", resolved: true });
    assert.ok(graph.relationships.some((rel) => rel.type === "DECLARES_ENTRYPOINT" && rel.to === entry.id && rel.from === "file:src/main/java/com/acme/app/Jobs.java"));
  });
});

describe("picocli entrypoints (fixtures/java-picocli)", () => {
  it("makes cli entrypoints of commands (run/call) and @Command methods, not of look-alikes", async () => {
    const graph = await buildCodeGraph(path.resolve("fixtures/java-picocli"), { continueOnError: false });
    assert.deepEqual(entries(graph), [
      "com.acme.cli.Greet.call cli picocli greet true",
      "com.acme.cli.Tool.run cli picocli tool true",
      "com.acme.cli.Tool.status cli picocli status true",
      "com.acme.cli.Tool.sync cli picocli sync true",
    ]);
  });
});

describe("entrypoint triggers that are not literals", () => {
  it("marks placeholders, constants, missing destinations and non-class event values unresolved", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "concentrate-java-ep-"));
    try {
      await mkdir(path.join(dir, "src/main/java/app"), { recursive: true });
      await writeFile(path.join(dir, "src/main/java/app/L.java"), `package app;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.kafka.annotation.TopicPartition;
import org.springframework.context.event.EventListener;
public class L {
  @Scheduled(cron = "\${x.cron}") void placeholder() {}
  @Scheduled(cron = "0 * * * * *") void literal() {}
  @KafkaListener(topics = "\${t}") void topicPlaceholder() {}
  @KafkaListener(topics = "orders") void topic() {}
  @KafkaListener(topicPartitions = @TopicPartition(topic = "p", partitions = "0")) void partitions() {}
  @EventListener(classes = FOO) void constant() {}
  @EventListener(OrderPlaced.class) void classLiteral() {}
  @EventListener void fromParameter(OrderPlaced event) {}
}
`);
      const graph = await buildCodeGraph(dir, { continueOnError: false });
      assert.deepEqual(entries(graph), [
        "app.L.classLiteral event spring OrderPlaced true",
        "app.L.constant event spring FOO false",
        "app.L.fromParameter event spring OrderPlaced true",
        "app.L.literal scheduler spring cron=0 * * * * * true",
        "app.L.partitions queue spring-kafka null false",
        "app.L.placeholder scheduler spring cron=${x.cron} false",
        "app.L.topic queue spring-kafka orders true",
        "app.L.topicPlaceholder queue spring-kafka ${t} false",
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

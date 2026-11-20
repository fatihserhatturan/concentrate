import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import {
  addJavaEntryPoint,
  annotationValue,
  findAnnotations,
  javaAnnotationReader,
  type JavaAnnotationInfo,
} from "./annotations.js";
import { javaMethods } from "./shared.js";

// Framework entrypoints of Java code that something other than the code itself calls:
//   @SpringBootApplication class      kind `spring-boot-application`, library `spring-boot`, trigger the
//                                     class name, handled by the class's `main`, which it RUNS (its `main`
//                                     EntryPoint). A class without a `main` is no entrypoint: an EntryPoint
//                                     needs a handler.
//   @Scheduled (Spring, Micronaut)    kind `scheduler` (as NestJS), trigger `cron=...`, `fixedRate=...`,
//                                     `fixedDelay=...` as written; one EntryPoint per attribute given
//   @KafkaListener / @RabbitListener / @JmsListener
//                                     kind `queue` (as Celery and Bull), trigger the topic, queue or
//                                     destination; one EntryPoint per name
//   @EventListener / @TransactionalEventListener
//                                     kind `event`, trigger the event type: `classes` (or `value`), else the
//                                     type of the single parameter
//   picocli @Command class            kind `cli` (as click, cobra and clap), library `picocli`, trigger the
//                                     command `name`, handled by its `run()` (Runnable) or `call()`
//                                     (Callable); @Command methods are subcommands named by `name`, else by
//                                     the method name
// `resolved` is false on an EntryPoint whose trigger is an expression (a constant, a placeholder) rather
// than a literal. An annotation of another package (provably, by import or qualified name) is no match.

const SPRING_BOOT = ["org.springframework.boot"];
const SPRING_SCHEDULING = ["org.springframework.scheduling.annotation"];
const MICRONAUT_SCHEDULING = ["io.micronaut.scheduling.annotation"];
const SPRING_EVENTS = ["org.springframework.context.event", "org.springframework.transaction.event"];
const PICOCLI = ["picocli"];
// `fixedRate = 5000` is as literal as a string is.
const NUMBER = /^\d[\d_]*[lL]?$/u;

type Parameter = { name?: string; type?: string | null };
type Trigger = { value: string | null; resolved: boolean };

function parametersOf(node: GraphNode): Parameter[] {
  try {
    const parsed: unknown = typeof node.properties.parameters === "string" ? JSON.parse(node.properties.parameters) : [];
    return Array.isArray(parsed) ? (parsed as Parameter[]) : [];
  } catch {
    return [];
  }
}

const simple = (name: string): string => name.replace(/<.*$/su, "").trim().split(".").pop() ?? name;

export const javaFrameworkEntrypointsContributor: ISemanticContributor = {
  id: "java.framework-entrypoints",
  dependsOn: ["java.entrypoints"],
  contribute(graph) {
    const reader = javaAnnotationReader(graph);
    const methods = javaMethods(graph).filter((method) => method.owner.label === "Class");

    // Imports by file, to tell Micronaut's @Scheduled from Spring's when neither is written qualified.
    const importSources = new Map<string, string[]>();
    for (const rel of graph.relationshipsOfType("IMPORTS")) {
      const source = graph.node(rel.to)?.properties.source;
      if (typeof source !== "string") continue;
      const list = importSources.get(rel.from);
      if (list) list.push(source);
      else importSources.set(rel.from, [source]);
    }

    const fileOfClass = new Map<string, string>();
    for (const rel of graph.relationshipsOfType("DEFINES_CLASS")) fileOfClass.set(rel.to, rel.from);
    const methodsOfClass = new Map<string, typeof methods>();
    for (const method of methods) {
      const list = methodsOfClass.get(method.owner.id);
      if (list) list.push(method);
      else methodsOfClass.set(method.owner.id, [method]);
    }
    // Method id -> its `main` EntryPoint.
    const mainEntryOf = new Map<string, string>();
    for (const rel of graph.relationshipsOfType("ENTRYPOINT_HANDLED_BY")) {
      if (graph.node(rel.from)?.properties.kind === "main") mainEntryOf.set(rel.to, rel.from);
    }

    // An annotation whose package is not provable (no import, no qualified name) is the user's own when a
    // scanned type of that name sits in the file's package (or nests in it): never a framework's.
    const packageOfFile = new Map<string, string>();
    for (const type of ["DEFINES_CLASS", "DEFINES_INTERFACE"] as const) {
      for (const rel of graph.relationshipsOfType(type)) {
        const namespace = graph.node(rel.to)?.properties.namespace;
        if (typeof namespace === "string") packageOfFile.set(rel.from, namespace);
      }
    }
    const typeNames = new Set<string>();
    for (const label of ["Class", "Interface"] as const) {
      for (const type of graph.nodesWithLabel(label)) {
        const { namespace, qualifiedName } = type.properties;
        if (typeof namespace === "string" && typeof qualifiedName === "string") typeNames.add(`${namespace}|${qualifiedName.slice(qualifiedName.lastIndexOf(".") + 1)}`);
      }
    }
    const find = (fileId: string, list: readonly JavaAnnotationInfo[], name: string, prefixes: readonly string[]): JavaAnnotationInfo[] =>
      findAnnotations(list, name, prefixes).filter((ann) => ann.qualifiedName !== null || !typeNames.has(`${packageOfFile.get(fileId) ?? ""}|${ann.simpleName}`));

    const emit = (fileId: string, handler: GraphNode, ann: JavaAnnotationInfo, kind: string, library: string, triggers: Trigger[]): void => {
      const list = triggers.length > 0 ? triggers : [{ value: null, resolved: true }];
      for (const trigger of list) {
        const entry = addJavaEntryPoint(graph, { fileId, kind, trigger: trigger.value, line: ann.line, handler, library });
        entry.properties.resolved = trigger.resolved;
      }
    };
    const values = (ann: JavaAnnotationInfo, key: string) => annotationValue(ann, key) ?? [];

    // ------------------------------------------------ classes
    for (const node of graph.nodesWithLabel("Class")) {
      const fileId = fileOfClass.get(node.id);
      if (!fileId || graph.node(fileId)?.properties.language !== "java") continue;
      const annotations = reader.annotationsOf(node);
      if (annotations.length === 0) continue;

      const boot = find(fileId, annotations, "SpringBootApplication", SPRING_BOOT)[0];
      if (boot) {
        const main = (methodsOfClass.get(node.id) ?? []).find((method) => mainEntryOf.has(method.node.id));
        if (main) {
          const entry = addJavaEntryPoint(graph, { fileId, kind: "spring-boot-application", trigger: String(node.properties.qualifiedName ?? node.properties.name), line: boot.line, handler: main.node, library: "spring-boot" });
          entry.properties.resolved = true;
          graph.addRelationship({ from: entry.id, to: mainEntryOf.get(main.node.id)!, type: "RUNS", properties: { line: boot.line, command: "SpringApplication.run" } });
        }
      }

      // picocli: the command's own `run()` / `call()`.
      const command = find(fileId, annotations, "Command", PICOCLI)[0];
      if (command) {
        let implemented: string[] = [];
        try {
          const parsed: unknown = typeof node.properties.implementsNames === "string" ? JSON.parse(node.properties.implementsNames) : [];
          if (Array.isArray(parsed)) implemented = parsed.map((name) => simple(String(name)));
        } catch {
          // Unreadable counts as none.
        }
        const handlerName = implemented.includes("Callable") ? "call" : implemented.includes("Runnable") ? "run" : null;
        const handler = handlerName
          ? (methodsOfClass.get(node.id) ?? []).find((method) => method.node.properties.name === handlerName && method.node.properties.parameterCount === 0 && method.node.properties.isStatic !== true)
          : undefined;
        if (handler) emit(fileId, handler.node, command, "cli", "picocli", values(command, "name").slice(0, 1));
      }
    }

    // ------------------------------------------------ methods
    for (const { node, fileId } of methods) {
      const annotations = reader.annotationsOf(node);
      if (annotations.length === 0) continue;

      for (const ann of annotations) {
        if (ann.simpleName !== "Scheduled") continue;
        const spring = find(fileId, [ann], "Scheduled", SPRING_SCHEDULING).length > 0;
        const micronaut = find(fileId, [ann], "Scheduled", MICRONAUT_SCHEDULING).length > 0;
        if (!spring && !micronaut) continue;
        const library = spring && micronaut
          ? (importSources.get(fileId) ?? []).some((source) => source.startsWith("io.micronaut.")) ? "micronaut" : "spring"
          : micronaut ? "micronaut" : "spring";
        const keys = library === "micronaut" ? ["cron", "fixedRate", "fixedDelay"] : ["cron", "fixedRate", "fixedDelay", "fixedRateString", "fixedDelayString"];
        emit(fileId, node, ann, "scheduler", library, keys.flatMap((key) => values(ann, key).map((value) => ({ value: `${key}=${value.value}`, resolved: value.resolved || NUMBER.test(value.value) }))));
      }

      for (const [name, prefixes, library, key] of [
        ["KafkaListener", ["org.springframework.kafka.annotation"], "spring-kafka", "topics"],
        ["RabbitListener", ["org.springframework.amqp.rabbit.annotation"], "spring-amqp", "queues"],
        ["JmsListener", ["org.springframework.jms.annotation"], "spring-jms", "destination"],
      ] as const) {
        for (const ann of find(fileId, annotations, name, prefixes)) {
          let triggers: Trigger[] = values(ann, key);
          // A topic pattern is marked so it is never read as a topic name.
          if (triggers.length === 0 && name === "KafkaListener") triggers = values(ann, "topicPattern").map((value) => ({ value: `pattern:${value.value}`, resolved: value.resolved }));
          emit(fileId, node, ann, "queue", library, triggers);
        }
      }

      for (const name of ["EventListener", "TransactionalEventListener"]) {
        for (const ann of find(fileId, annotations, name, SPRING_EVENTS)) {
          let triggers: Trigger[] = [...values(ann, "classes"), ...values(ann, "value")].map((value) => ({ value: value.value.replace(/\.class$/u, ""), resolved: true }));
          if (triggers.length === 0) {
            const parameters = parametersOf(node);
            if (parameters.length === 1 && parameters[0]!.type) triggers = [{ value: parameters[0]!.type!, resolved: true }];
          }
          emit(fileId, node, ann, "event", "spring", triggers);
        }
      }

      // picocli subcommand methods: named by `name`, else by the method.
      for (const ann of find(fileId, annotations, "Command", PICOCLI)) {
        const name = values(ann, "name")[0] ?? { value: String(node.properties.name), resolved: true };
        emit(fileId, node, ann, "cli", "picocli", [name]);
      }
    }
  },
};

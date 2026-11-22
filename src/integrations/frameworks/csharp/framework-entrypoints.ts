import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphSchemaExtension } from "../../../core/graph/schema.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";
import { usingsInScope } from "../../languages/csharp/namespaces.js";
import {
  attributeValue,
  argumentExpression,
  csharpAttributeReader,
  csharpStringLiteral,
  findAttributes,
  inNamespace,
  namedArgument,
  positionalArguments,
  type CSharpAttributeInfo,
} from "./attributes.js";
import { addCSharpEntryPoint, addCSharpRoute, joinRoutePath } from "./emit.js";
import { argumentInfo, dottedText, invocationInfo, type ArgumentInfo } from "./invocations.js";
import { csharpMethods, csharpTypeNodes, parametersOf } from "./shared.js";
import { csharpTypeResolver } from "./type-names.js";
import { argumentNodes } from "../../languages/csharp/syntax.js";

// Framework entrypoints of C# code that something other than the code itself calls:
//   BackgroundService subclass        kind `hosted-service`, library `hosted-service`, trigger the class name,
//                                     handled by its `ExecuteAsync` (the nearest one up the scanned base classes)
//   IHostedService / IHostedLifecycleService implementation
//                                     same kind and trigger, handled by `StartAsync`. `StopAsync` is no second
//                                     entrypoint: it is the shutdown half of the same service (one entrypoint per
//                                     service keeps the trigger unique); `IHostedLifecycleService`'s extra hooks are
//                                     not entrypoints either. A concrete class only: an abstract base is never run.
//                                     `registered` is true when `AddHostedService<T>()` (or an
//                                     `AddSingleton<IHostedService, T>()`) in the scan names the class, false otherwise
//                                     (it may be registered by a library or another repository).
//   Azure Functions                   kind `function`, library `azure-functions`, handled by the method marked
//                                     `[Function("Name")]` (isolated worker) or `[FunctionName("Name")]` (in-process).
//                                     The trigger comes from the attribute on a parameter:
//                                       HttpTrigger            `http` (plus a Route per verb, framework `azure-functions`)
//                                       TimerTrigger           `timer:<cron>`
//                                       QueueTrigger           `queue:<queue>`
//                                       BlobTrigger            `blob:<path>`
//                                       ServiceBusTrigger      `servicebus:<queue or topic>[/<subscription>]`
//                                       EventHubTrigger        `eventhub:<hub>`
//                                       CosmosDBTrigger        `cosmosdb:<database>/<container>`
//                                       KafkaTrigger           `kafka:<topic>`
//                                       RabbitMQTrigger        `rabbitmq:<queue>`
//                                       EventGridTrigger, OrchestrationTrigger, ActivityTrigger, EntityTrigger
//                                                              the lower case kind alone (`eventgrid`, `orchestration`...)
//                                       any other `XTrigger`   `x` (and `x:<first literal>` is not guessed)
//                                     A `[Function]` without a trigger parameter keeps trigger null.
//                                     A Route has the path of the attribute's `Route` (default: the function name)
//                                     under the prefix of the nearest `host.json` (`extensions.http.routePrefix`, default
//                                     `api`); one Route per verb, `ALL` when none is listed.
//   System.CommandLine                kind `cli`, library `system-commandline`, trigger the command path (`tool sub`):
//                                     the names of the commands from the root down, joined by a space. A `RootCommand`
//                                     takes its name from the executable, which the code does not give: its segment is
//                                     left out (`RootCommand` alone is `<root>`, its subcommand `add`). Commands are
//                                     built with `new Command("name")` / `new RootCommand()`, nested with `AddCommand`,
//                                     `Add`, `Subcommands.Add` or a collection initializer, and run by `SetHandler`,
//                                     `SetAction` or `Handler = CommandHandler.Create(...)`: the handler is a method
//                                     (resolved by name) or, for a lambda, the function that holds it. A command without
//                                     a handler (a plain group) is no entrypoint.
// `resolved` is true only when the trigger is a literal. It is false for a constant, `nameof`, interpolation or a
// `%Setting%` placeholder (the trigger then keeps the written text), and for an entrypoint without a trigger.
// Attributes are matched by simple name and namespace by `findAttributes` (see attributes.ts).

const WORKER = ["Microsoft.Azure.Functions.Worker"];
const WEBJOBS = ["Microsoft.Azure.WebJobs"];
const COMMANDLINE = "System.CommandLine";
const PLACEHOLDER = /%[^%\s]+%/u;

type Value = { value: string; resolved: boolean };

// ---------------------------------------------------------------- parse plugin: System.CommandLine

type CommandHandlerFact = { kind: "lambda" | "method"; text: string; fn: string };
type CommandFact = { line: number; type: string; fn: string; trigger: string; resolved: boolean; handlers: CommandHandlerFact[] };

type CommandRecord = {
  fn: string;
  line: number;
  type: string;
  isRoot: boolean;
  name: Value | null;
  parent: number | null;
  handlers: CommandHandlerFact[];
};

const lastSegmentOf = (type: string): string => type.replace(/<.*$/su, "").trim().split(".").pop() ?? type;

function declaredTypeOf(node: SyntaxNode): string | null {
  // `Command add = new("add");` / `static Command f = new("x");`: the type written on the declaration.
  let current: SyntaxNode | null = node.parent;
  while (current && current.type !== "variable_declarator" && current.type !== "assignment_expression") current = current.parent;
  if (current?.type !== "variable_declarator") return null;
  const declaration = current.parent;
  const type = declaration?.childForFieldName("type") ?? declaration?.namedChildren.find((child) => child.type !== "variable_declarator") ?? null;
  return type && type.type !== "implicit_type" ? type.text : null;
}

function bindingOf(node: SyntaxNode): { name: string | null; field: boolean } {
  let current: SyntaxNode | null = node.parent;
  if (current?.type === "equals_value_clause") current = current.parent;
  let name: string | null = null;
  if (current?.type === "variable_declarator") name = current.namedChildren.find((child) => child.type === "identifier")?.text ?? null;
  else if (current?.type === "assignment_expression" && current.childForFieldName("right")?.id === node.id) {
    const left = dottedText(current.childForFieldName("left"));
    name = left ? left.split(".").pop() ?? null : null;
  }
  let field = false;
  for (let up: SyntaxNode | null = node.parent; up; up = up.parent) {
    if (up.type === "field_declaration" || up.type === "property_declaration") field = true;
    if (up.type === "method_declaration" || up.type === "constructor_declaration" || up.type === "local_function_statement" || up.type === "lambda_expression") {
      field = false;
      break;
    }
  }
  return { name: name && /^[A-Za-z_]\w*$/u.test(name) ? name : null, field };
}

const argumentsOfCreation = (node: SyntaxNode): ArgumentInfo[] => {
  const list = node.namedChildren.find((child) => child.type === "argument_list") ?? null;
  return argumentNodes(list).flatMap((argument) => {
    const info = argumentInfo(argument);
    return info ? [info] : [];
  });
};

const valueOfName = (argument: ArgumentInfo | undefined): Value | null => (argument ? (argument.kind === "string" ? { value: argument.value!, resolved: true } : { value: argument.text, resolved: false }) : null);

export const csharpFrameworkEntrypointsPlugin: VersionedCSharpParsePlugin = Object.assign(
  ({ fileNodeId, root, nodes, functions, calls }: Parameters<VersionedCSharpParsePlugin>[0]) => {
    if (!root.text.includes("Command")) return;
    const records: CommandRecord[] = [];
    const created = new Map<number, number>();
    const byScope = new Map<string, number>();
    const fields = new Map<string, number>();

    // 1. Command creations: `new Command("x")`, `new RootCommand()`, `Command x = new("x")`.
    for (const { syntax, function: fn } of calls) {
      if (syntax.type !== "object_creation_expression" && syntax.type !== "implicit_object_creation_expression") continue;
      const type = syntax.type === "object_creation_expression" ? syntax.childForFieldName("type")?.text ?? null : declaredTypeOf(syntax);
      if (!type) continue;
      const last = lastSegmentOf(type);
      if (last !== "Command" && last !== "RootCommand") continue;
      const args = argumentsOfCreation(syntax);
      const isRoot = last === "RootCommand";
      const nameArgument = isRoot ? undefined : args.find((arg) => arg.name === "name") ?? args.find((arg) => arg.name === null);
      const index = records.length;
      records.push({ fn: fn.id, line: syntax.startPosition.row + 1, type, isRoot, name: valueOfName(nameArgument), parent: null, handlers: [] });
      created.set(syntax.id, index);
      const binding = bindingOf(syntax);
      if (binding.name) {
        byScope.set(`${fn.id}\0${binding.name}`, index);
        if (binding.field) fields.set(binding.name, index);
      }
    }
    if (records.length === 0) return;

    const lookup = (name: string, fnId: string): number | null => byScope.get(`${fnId}\0${name}`) ?? fields.get(name) ?? null;
    const returned = new Map<string, number>();
    const refOf = (node: SyntaxNode | null | undefined, fnId: string): number | null => {
      if (!node) return null;
      const known = created.get(node.id);
      if (known !== undefined) return known;
      if (node.type === "parenthesized_expression") return refOf(node.namedChildren[0], fnId);
      if (node.type === "identifier" || node.type === "member_access_expression") {
        const text = dottedText(node);
        return text ? lookup(text.split(".").pop()!, fnId) : null;
      }
      if (node.type === "invocation_expression") {
        const info = invocationInfo(node);
        return info ? returned.get(info.name) ?? null : null;
      }
      return null;
    };

    // 2. Methods that return a command (`static Command BuildAdd() { var add = new Command("add"); ...; return add; }`).
    const names = new Map<string, number>();
    for (const { syntax, node } of functions) {
      if (syntax.type === "compilation_unit") continue;
      const name = String(node.properties.name);
      names.set(name, (names.get(name) ?? 0) + 1);
      const stack = [syntax];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current.type === "return_statement" || current.type === "arrow_expression_clause") {
          const found = refOf(current.namedChildren.find((child) => child.type !== "comment") ?? null, node.id);
          if (found !== null && !returned.has(name)) returned.set(name, found);
        }
        for (const child of current.namedChildren) stack.push(child);
      }
    }
    for (const [name, count] of names) if (count > 1) returned.delete(name);

    const handlerOf = (argument: ArgumentInfo | undefined, fnId: string): CommandHandlerFact | null => {
      if (!argument) return null;
      if (argument.kind === "lambda") return { kind: "lambda", text: "", fn: fnId };
      if (argument.kind === "method-group") {
        const text = dottedText(argument.node);
        return text ? { kind: "method", text, fn: fnId } : null;
      }
      return null;
    };
    const link = (child: number | null, parent: number | null): void => {
      if (child === null || parent === null || child === parent || records[child]!.parent !== null) return;
      // No cycles: the parent must not descend from the child.
      for (let up: number | null = parent; up !== null; up = records[up]!.parent) if (up === child) return;
      records[child]!.parent = parent;
    };

    // 3. Initializers: `new Command("a") { Name = "b", child, Subcommands = { c } }`.
    for (const { syntax, function: fn } of calls) {
      const index = created.get(syntax.id);
      if (index === undefined) continue;
      const initializer = syntax.namedChildren.find((child) => child.type === "initializer_expression");
      if (!initializer) continue;
      for (const element of initializer.namedChildren) {
        if (element.type === "comment") continue;
        if (element.type === "assignment_expression") {
          const left = dottedText(element.childForFieldName("left"));
          const right = element.childForFieldName("right");
          if (left === "Name" && right) {
            const text = csharpStringLiteral(right.text);
            records[index]!.name = text === null ? { value: right.text, resolved: false } : { value: text, resolved: true };
          } else if (left === "Subcommands" && right?.type === "initializer_expression") {
            for (const child of right.namedChildren) link(refOf(child, fn.id), index);
          }
        } else link(refOf(element, fn.id), index);
      }
    }

    // 4. Calls: `AddCommand`, `Add`, `Subcommands.Add`, `SetHandler`, `SetAction`, `Handler = CommandHandler.Create(...)`.
    for (const { syntax, function: fn } of calls) {
      const info = invocationInfo(syntax);
      if (!info) continue;
      const receiver = info.receiver;
      if ((info.name === "AddCommand" || info.name === "Add") && info.arguments.length === 1 && receiver) {
        const target = receiver.type === "member_access_expression" && receiver.childForFieldName("name")?.text === "Subcommands" ? receiver.childForFieldName("expression") : receiver;
        link(refOf(info.arguments[0]!.node, fn.id), refOf(target, fn.id));
      } else if (info.name === "SetHandler" || info.name === "SetAction") {
        const target = refOf(receiver, fn.id);
        const handler = target === null ? null : handlerOf(info.arguments[0], fn.id);
        if (target !== null && handler) records[target]!.handlers.push(handler);
      } else if (info.name === "Create" && receiver && dottedText(receiver)?.split(".").pop() === "CommandHandler") {
        const parent = syntax.parent;
        if (parent?.type !== "assignment_expression" || parent.childForFieldName("right")?.id !== syntax.id) continue;
        const left = parent.childForFieldName("left");
        let target: number | null = null;
        if (left?.type === "member_access_expression" && left.childForFieldName("name")?.text === "Handler") target = refOf(left.childForFieldName("expression"), fn.id);
        else if (left?.type === "identifier" && left.text === "Handler" && parent.parent?.type === "initializer_expression") target = created.get(parent.parent.parent?.id ?? -1) ?? null;
        const handler = target === null ? null : handlerOf(info.arguments[0], fn.id);
        if (target !== null && handler) records[target]!.handlers.push(handler);
      }
    }

    // 5. Paths: the names from the root down. A RootCommand without `Name = ...` has no name the code knows.
    const facts: CommandFact[] = [];
    for (const [index, record] of records.entries()) {
      if (record.handlers.length === 0) continue;
      const segments: Value[] = [];
      for (let up: number | null = index; up !== null; up = records[up]!.parent) {
        const current = records[up]!;
        const segment = current.isRoot ? current.name : current.name ?? { value: "<unnamed>", resolved: false };
        if (segment) segments.unshift(segment);
      }
      facts.push({
        line: record.line,
        type: record.type,
        fn: record.fn,
        trigger: segments.length > 0 ? segments.map((segment) => segment.value).join(" ") : "<root>",
        resolved: segments.every((segment) => segment.resolved),
        handlers: record.handlers,
      });
    }
    if (facts.length === 0) return;
    const file = nodes.find((node) => node.id === fileNodeId);
    if (file) file.properties.csharpCommandLine = JSON.stringify(facts);
  },
  { version: "1" },
);

// ---------------------------------------------------------------- contributor

function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === "<" || char === "(" || char === "[") depth += 1;
    else if (char === ">" || char === ")" || char === "]") depth -= 1;
    else if (char === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter((part) => part !== "");
}

const asValue = (expression: string | null): Value | null => {
  const value = attributeValue(expression);
  return value ? { value: value.value, resolved: value.resolved && !PLACEHOLDER.test(value.value) } : null;
};

// What to read from a trigger attribute's arguments, as [key, positional index] pairs: the named argument `key`
// wins over the positional one.
const TRIGGER_NAMES: Record<string, ReadonlyArray<readonly [string, number]>> = {
  timer: [["Schedule", 0]],
  queue: [["QueueName", 0]],
  blob: [["BlobPath", 0]],
  servicebus: [["QueueName", 0], ["SubscriptionName", 1]],
  eventhub: [["EventHubName", 0]],
  cosmosdb: [["DatabaseName", 0], ["ContainerName", 1]],
  kafka: [["Topic", 1]],
  rabbitmq: [["QueueName", 0]],
};

type Trigger = { kind: string; attribute: { args: string[] }; value: string | null; resolved: boolean };

function triggerOf(kind: string, attribute: { args: string[] }): Trigger {
  const wanted = TRIGGER_NAMES[kind];
  if (!wanted) return { kind, attribute, value: kind, resolved: true };
  const parts: Value[] = [];
  for (const [key, index] of wanted) {
    const value = asValue(argumentExpression(attribute, index, key));
    if (value) parts.push(value);
  }
  if (parts.length === 0) return { kind, attribute, value: `${kind}`, resolved: false };
  return { kind, attribute, value: `${kind}:${parts.map((part) => part.value).join("/")}`, resolved: parts.every((part) => part.resolved) };
}

async function readRoutePrefix(rootPath: string, relativeFile: string, cache: Map<string, string>): Promise<string> {
  let dir = path.posix.dirname(relativeFile.replace(/\\/gu, "/"));
  const visited: string[] = [];
  let prefix = "api";
  for (;;) {
    const known = cache.get(dir);
    if (known !== undefined) {
      prefix = known;
      break;
    }
    visited.push(dir);
    let found: string | null = null;
    try {
      const parsed = JSON.parse(await readFile(path.join(rootPath, dir, "host.json"), "utf8")) as { extensions?: { http?: { routePrefix?: unknown } } };
      const value = parsed.extensions?.http?.routePrefix;
      found = typeof value === "string" ? value : "api";
    } catch {
      // No (readable) host.json here: look one level up.
    }
    if (found !== null) {
      prefix = found;
      break;
    }
    if (dir === "." || dir === "" || dir === "/") break;
    dir = path.posix.dirname(dir);
  }
  for (const entry of visited) cache.set(entry, prefix);
  return prefix;
}

export const csharpFrameworkEntrypointsContributor: ISemanticContributor = {
  id: "csharp.framework-entrypoints",
  dependsOn: ["csharp.entrypoints"],
  async contribute(graph, rootPath) {
    const resolver = csharpTypeResolver(graph);
    const methods = csharpMethods(graph);
    const fileOfMethod = new Map(methods.map((method) => [method.node.id, method.fileId]));

    // ------------------------------------------------ hosted services
    const registered = new Set<string>();
    for (const call of graph.nodesWithLabel("Call")) {
      const callee = call.properties.callee;
      if (typeof callee !== "string" || typeof call.properties.typeArguments !== "string") continue;
      const args = splitTopLevel(call.properties.typeArguments);
      let written: string | undefined;
      if (callee === "AddHostedService" && args.length === 1) written = args[0];
      else if (/^(?:Try)?Add(?:Singleton|Transient|Scoped)$/u.test(callee) && args.length === 2 && lastSegmentOf(args[0]!) === "IHostedService") written = args[1];
      const type = written ? resolver.resolve(written, call) : null;
      if (type) registered.add(type.id);
    }

    const handlerOf = (typeNode: GraphNode, name: string): GraphNode | null => {
      const start = resolver.typeOf(typeNode);
      if (!start) return null;
      const seen = new Set<string>();
      let level = [start];
      while (level.length > 0) {
        const found: GraphNode[] = [];
        for (const type of level) {
          if (seen.has(type.id)) continue;
          seen.add(type.id);
          if (type.isInterface) continue;
          found.push(...resolver.methodsOf(type).filter((method) => method.properties.name === name && method.properties.kind === "method" && method.properties.isStatic !== true && method.properties.isAbstract !== true));
        }
        if (found.length > 0) return found[0]!;
        level = level.flatMap((type) => resolver.index.supertypes(type));
      }
      return null;
    };

    for (const node of csharpTypeNodes(graph)) {
      if (node.label !== "Class" || node.properties.kind !== "class" || node.properties.isAbstract === true) continue;
      const type = resolver.typeOf(node);
      if (!type) continue;
      const background = resolver.derivesFromExternal(type, ["BackgroundService"]);
      if (!background && !resolver.derivesFromExternal(type, ["IHostedService", "IHostedLifecycleService"])) continue;
      const handler = handlerOf(node, background ? "ExecuteAsync" : "StartAsync");
      const fileId = handler ? fileOfMethod.get(handler.id) : undefined;
      if (!handler || !fileId) continue;
      const entry = addCSharpEntryPoint(graph, { fileId, kind: "hosted-service", trigger: String(node.properties.name), line: Number(handler.properties.line), handler, library: "hosted-service" });
      entry.properties.resolved = true;
      entry.properties.registered = registered.has(type.id);
    }

    // ------------------------------------------------ Azure Functions
    const reader = csharpAttributeReader(graph);
    const prefixCache = new Map<string, string>();
    const relativeOf = (fileId: string): string => String(graph.node(fileId)?.properties.relativePath ?? "");
    for (const { node, owner, fileId } of methods) {
      if (owner.label !== "Class" || node.properties.kind !== "method") continue;
      const attributes = reader.attributesOf(node);
      if (attributes.length === 0) continue;
      const marker: CSharpAttributeInfo | undefined = findAttributes(attributes, "Function", WORKER)[0] ?? findAttributes(attributes, "FunctionName", WEBJOBS)[0];
      if (!marker) continue;
      const functionName = asValue(argumentExpression(marker, 0, "Name")) ?? { value: String(node.properties.name), resolved: true };

      const triggers: Trigger[] = [];
      for (const parameter of parametersOf(node)) {
        for (const annotation of parameter.annotations ?? []) {
          const simple = (annotation.name.split(".").pop() ?? annotation.name).replace(/Attribute$/u, "");
          if (!simple.endsWith("Trigger") || simple === "Trigger") continue;
          // A trigger attribute the scan declares itself is the user's own.
          if (resolver.resolve(annotation.name, node) ?? resolver.resolve(`${annotation.name}Attribute`, node)) continue;
          triggers.push(triggerOf(simple.slice(0, -"Trigger".length).toLowerCase(), annotation));
        }
      }

      const emit = (trigger: string | null, resolved: boolean) => {
        const entry = addCSharpEntryPoint(graph, { fileId, kind: "function", trigger, line: marker.line, handler: node, library: "azure-functions" });
        entry.properties.resolved = resolved;
      };
      if (triggers.length === 0) emit(null, false);
      for (const trigger of triggers) {
        if (trigger.kind !== "http") {
          emit(trigger.value, trigger.resolved);
          continue;
        }
        emit("http", true);
        const verbs = positionalArguments(trigger.attribute).flatMap((expression) => {
          const literal = csharpStringLiteral(expression);
          return literal === null ? [] : [literal.toUpperCase()];
        });
        const routeExpression = namedArgument(trigger.attribute, "Route");
        const route = routeExpression === null || routeExpression === "null" ? functionName : (asValue(routeExpression) ?? functionName);
        const prefix = route.resolved ? await readRoutePrefix(rootPath, relativeOf(fileId), prefixCache) : "";
        for (const method of verbs.length > 0 ? [...new Set(verbs)] : ["ALL"]) {
          addCSharpRoute(graph, {
            fileId,
            method,
            path: route.resolved ? joinRoutePath(prefix, route.value) : null,
            pathExpression: routeExpression ?? marker.args[0] ?? null,
            framework: "azure-functions",
            line: marker.line,
            handler: node,
          });
        }
      }
    }

    // ------------------------------------------------ System.CommandLine
    for (const file of graph.nodesWithLabel("File")) {
      if (typeof file.properties.csharpCommandLine !== "string") continue;
      let facts: CommandFact[] = [];
      try {
        facts = JSON.parse(file.properties.csharpCommandLine) as CommandFact[];
      } catch {
        // Unreadable facts count as none.
      }
      delete file.properties.csharpCommandLine;
      for (const fact of facts) {
        const scope = graph.node(fact.fn);
        if (!scope) continue;
        // `Command` / `RootCommand` must be System.CommandLine's: not a type the scan declares, and the namespace brought in (or the type written qualified).
        if (resolver.resolve(fact.type, scope)) continue;
        const namespaces = usingsInScope(graph, file.id, String(scope.properties.namespace ?? ""), fact.line).namespaces;
        if (!inNamespace(fact.type, COMMANDLINE) && !namespaces.some((using) => inNamespace(using, COMMANDLINE))) continue;
        for (const handler of fact.handlers) {
          const target = handler.kind === "lambda" ? scope.id === handler.fn ? scope : graph.node(handler.fn) : resolveMethod(handler.text, handler.fn);
          if (!target) continue;
          const entry = addCSharpEntryPoint(graph, { fileId: file.id, kind: "cli", trigger: fact.trigger, line: fact.line, handler: target, library: "system-commandline" });
          entry.properties.resolved = fact.resolved;
        }
      }
    }

    // A handler written as a method group: `Run` in the type that holds the call, or `Type.Run` / `this.Run`.
    function resolveMethod(text: string, fnId: string): GraphNode | null {
      const scope = graph.node(fnId);
      if (!scope) return null;
      const parts = text.split(".");
      if (parts[0] === "this") parts.shift();
      const name = parts.pop();
      if (!name) return null;
      const typeNode = parts.length === 0 ? resolver.ownerOf(scope) : resolver.resolve(parts.join("."), scope)?.node;
      if (!typeNode) return null;
      const found = handlersNamed(typeNode, name);
      return found.length === 1 ? found[0]! : null;
    }
    function handlersNamed(typeNode: GraphNode, name: string): GraphNode[] {
      const start = resolver.typeOf(typeNode);
      const seen = new Set<string>();
      let level = start ? [start] : [];
      while (level.length > 0) {
        const found: GraphNode[] = [];
        for (const type of level) {
          if (seen.has(type.id)) continue;
          seen.add(type.id);
          found.push(...resolver.methodsOf(type).filter((method) => method.properties.name === name && method.properties.kind === "method"));
        }
        if (found.length > 0) return found;
        level = level.flatMap((type) => resolver.index.supertypes(type));
      }
      return [];
    }
  },
};

// `resolved` (shared with the Java entrypoints) and `registered` (hosted services: named by `AddHostedService<T>()`).
export const csharpFrameworkEntrypointsSchema: GraphSchemaExtension = {
  id: "csharp-framework-entrypoints",
  nodeProperties: [{ label: "EntryPoint", after: "handlerName", properties: { resolved: "BOOLEAN", registered: "BOOLEAN" } }],
};

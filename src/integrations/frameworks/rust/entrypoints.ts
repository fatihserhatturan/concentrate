import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { rustAttributesOf, rustBaseTypeName, type RustParsePlugin } from "../../languages/rust/parser.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createRustCallIndex, resolveRustCall } from "../../../core/scan/resolution/rust-calls.js";
import type { RustRef } from "./routes.js";

// Rust entrypoints besides `fn main`:
//
// - tonic: `XServer::new(MyService::default())` serves the trait `X`; every
//   method of `impl X for MyService` is an EntryPoint (kind `grpc`,
//   trigger `X/method`).
// - clap: a `#[derive(Parser)]` struct and its `#[derive(Subcommand)]` enums
//   (nested through `Args` structs), or the builder's `Command::new("app")
//   .subcommand(Command::new("serve"))`, become EntryPoints (kind `cli`,
//   trigger the command path, `serve` or `db migrate`). A command is handled
//   by the function its `match` arm calls
//   (`Commands::Serve { .. } => serve(..)`, `Some(("serve", m)) => serve(m)`).
//
// The plugin keeps what a file declares on its File node; the contributor
// joins the files, makes the nodes and removes that data.

type GrpcServer = { service: string; type: string | null; line: number; column: number; expression: string };

type ClapVariant = { name: string; cliName: string; fieldType: string | null; subcommandType: string | null; line: number; column: number };
type ClapType =
  | { kind: "parser"; name: string; cliName: string | null; subcommandType: string | null; line: number; column: number }
  | { kind: "args"; name: string; subcommandType: string | null }
  | { kind: "subcommand"; name: string; variants: ClapVariant[] };
type ClapArm = { enum: string | null; variant: string | null; command: string | null; calls: RustRef[]; functionId: string };
type ClapBuilder = { path: string[]; line: number; column: number };
type ClapFile = { types: ClapType[]; arms: ClapArm[]; builders: ClapBuilder[] };

const NOT_HANDLERS = new Set(["Ok", "Err", "Some", "None", "Box::new", "Arc::new", "Vec::new", "String::from", "format", "println", "eprintln", "panic"]);

function kebab(name: string): string {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1-$2").replace(/_/gu, "-").toLowerCase();
}

function argValue(args: readonly string[], key: string): string | null {
  for (const arg of args) {
    const match = new RegExp(`^${key}\\s*=\\s*"([^"]*)"$`, "u").exec(arg.trim());
    if (match) return match[1]!;
  }
  return null;
}

// `Option<Commands>` → `Commands`.
function innerType(type: string): string | null {
  const compact = type.replace(/\s+/gu, "");
  const unwrapped = /^(?:Option|Box|Vec)<(.+)>$/u.exec(compact)?.[1] ?? compact;
  return /^(?:\w+::)*(\w+)$/u.exec(unwrapped.replace(/^&/u, ""))?.[1] ?? null;
}

function stringLiteral(node: SyntaxNode | null | undefined): string | null {
  if (!node) return null;
  const text = node.text;
  return node.type === "string_literal" && /^"[^"\\]*"$/u.test(text) ? text.slice(1, -1) : null;
}

export const rustEntrypointsPlugin: RustParsePlugin = ({ fileNodeId, root, nodes, functions }) => {
  const file = nodes.find((node) => node.id === fileNodeId);
  if (!file) return;
  const source = root.text;
  const hasTonic = /\btonic\b/u.test(source);
  const hasClap = /\bclap\b/u.test(source);
  if (!hasTonic && !hasClap) return;

  const functionIdOf = (node: SyntaxNode): string | null => {
    for (let parent: SyntaxNode | null = node; parent; parent = parent.parent) {
      if (parent.type !== "function_item") continue;
      return functions.find((fn) => fn.syntax.id === parent!.id)?.node.id ?? null;
    }
    return null;
  };

  if (hasTonic) {
    const servers: GrpcServer[] = [];
    for (const call of root.descendantsOfType("call_expression")) {
      let callee = call.childForFieldName("function");
      if (callee?.type === "generic_function") callee = callee.childForFieldName("function");
      if (callee?.type !== "scoped_identifier") continue;
      const segments = callee.text.replace(/\s+/gu, "").split("::");
      const method = segments.at(-1)!;
      const type = segments.at(-2);
      if (!type || !/^[A-Z]\w*Server$/u.test(type) || !["new", "with_interceptor", "from_arc"].includes(method)) continue;
      const arg = call.childForFieldName("arguments")?.namedChildren[0];
      servers.push({
        service: type.slice(0, -"Server".length),
        type: arg ? valueType(arg, call) : null,
        line: call.startPosition.row + 1,
        column: call.startPosition.column,
        expression: call.text.slice(0, 80),
      });
    }
    if (servers.length > 0) file.properties.rustGrpcServers = JSON.stringify(servers);
  }

  if (hasClap) {
    const clap: ClapFile = { types: [], arms: [], builders: [] };
    for (const node of root.descendantsOfType(["struct_item", "enum_item"])) {
      const attributes = rustAttributesOf(node);
      const derives = attributes.filter((attribute) => attribute.name === "derive" || attribute.name.endsWith("::derive")).flatMap((attribute) => attribute.args.map((arg) => arg.replace(/^.*::/u, "")));
      const name = node.childForFieldName("name")?.text;
      if (!name) continue;
      const command = attributes.filter((attribute) => attribute.name === "command" || attribute.name === "clap");
      const explicitName = command.map((attribute) => argValue(attribute.args, "name")).find((value) => value !== null) ?? null;
      if (node.type === "struct_item") {
        if (!derives.includes("Parser") && !derives.includes("Args")) continue;
        const subcommandType = subcommandFieldType(node.childForFieldName("body"));
        if (derives.includes("Parser")) {
          clap.types.push({ kind: "parser", name, cliName: explicitName, subcommandType, line: node.startPosition.row + 1, column: node.startPosition.column });
        } else {
          clap.types.push({ kind: "args", name, subcommandType });
        }
      } else if (derives.includes("Subcommand")) {
        const variants: ClapVariant[] = [];
        for (const variant of node.childForFieldName("body")?.namedChildren ?? []) {
          if (variant.type !== "enum_variant") continue;
          const variantName = variant.childForFieldName("name")?.text;
          if (!variantName) continue;
          const variantCommand = rustAttributesOf(variant).filter((attribute) => attribute.name === "command" || attribute.name === "clap");
          const body = variant.childForFieldName("body");
          const tuple = body?.type === "ordered_field_declaration_list" ? body.namedChildren.find((child) => child.type !== "visibility_modifier" && child.type !== "attribute_item") : undefined;
          variants.push({
            name: variantName,
            cliName: variantCommand.map((attribute) => argValue(attribute.args, "name")).find((value) => value !== null) ?? kebab(variantName),
            fieldType: tuple ? innerType(tuple.text) : null,
            subcommandType: body?.type === "field_declaration_list" ? subcommandFieldType(body) : null,
            line: variant.startPosition.row + 1,
            column: variant.startPosition.column,
          });
        }
        clap.types.push({ kind: "subcommand", name, variants });
      }
    }

    // Match arms that dispatch a command.
    for (const arm of root.descendantsOfType("match_arm")) {
      const pattern = arm.childForFieldName("pattern")?.text ?? "";
      const value = arm.childForFieldName("value");
      const functionId = functionIdOf(arm);
      if (!value || !functionId) continue;
      const calls = armCalls(value);
      const builder = /\(\s*"([^"]+)"\s*,/u.exec(pattern)?.[1] ?? null;
      if (builder && /^\s*Some\s*\(/u.test(pattern)) {
        clap.arms.push({ enum: null, variant: null, command: builder, calls, functionId });
        continue;
      }
      for (const match of pattern.matchAll(/\b(\w+)::(\w+)\b/gu)) {
        if (match[1] === "Some" || match[1] === "Ok" || match[1] === "Err") continue;
        clap.arms.push({ enum: match[1]!, variant: match[2]!, command: null, calls, functionId });
      }
    }

    // The builder: `Command::new("app").subcommand(Command::new("serve"))`.
    const claimed = new Set<number>();
    type Built = { name: string; children: Built[]; line: number; column: number };
    const commandOf = (node: SyntaxNode, depth = 0): Built | null => {
      if (depth > 6) return null;
      if (node.type === "reference_expression" || node.type === "parenthesized_expression") {
        const inner = node.childForFieldName("value") ?? node.namedChildren[0];
        return inner ? commandOf(inner, depth + 1) : null;
      }
      if (node.type !== "call_expression") return null;
      const callee = node.childForFieldName("function");
      if (callee?.type === "field_expression") {
        const receiver = callee.childForFieldName("value");
        const base = receiver ? commandOf(receiver, depth + 1) : null;
        if (!base) return null;
        if (callee.childForFieldName("field")?.text === "subcommand") {
          const child = node.childForFieldName("arguments")?.namedChildren[0];
          const built = child ? commandOf(child, depth + 1) : null;
          if (child && built) claimed.add(child.startIndex);
          if (built) base.children.push(built);
        }
        return base;
      }
      if (callee && /(^|::)Command::new$/u.test(callee.text.replace(/\s+/gu, ""))) {
        const name = stringLiteral(node.childForFieldName("arguments")?.namedChildren[0]);
        return name ? { name, children: [], line: node.startPosition.row + 1, column: node.startPosition.column } : null;
      }
      return null;
    };
    for (const call of root.descendantsOfType("call_expression")) {
      const parent = call.parent;
      if (parent?.type === "field_expression" && parent.childForFieldName("value")?.id === call.id) continue;
      const command = commandOf(call);
      if (!command || claimed.has(call.startIndex)) continue;
      claimed.add(call.startIndex);
      const walk = (entry: Built, path: string[]) => {
        const next = [...path, entry.name];
        clap.builders.push({ path: next, line: entry.line, column: entry.column });
        for (const child of entry.children) walk(child, next);
      };
      walk(command, []);
    }

    if (clap.types.length > 0 || clap.builders.length > 0) file.properties.rustClap = JSON.stringify(clap);
  }
};

// The type of the field marked `#[command(subcommand)]`.
function subcommandFieldType(body: SyntaxNode | null): string | null {
  for (const field of body?.namedChildren ?? []) {
    if (field.type !== "field_declaration") continue;
    if (!rustAttributesOf(field).some((attribute) => (attribute.name === "command" || attribute.name === "clap") && attribute.args.includes("subcommand"))) continue;
    const type = field.childForFieldName("type")?.text;
    return type ? innerType(type) : null;
  }
  return null;
}

// What a match arm calls first: functions by path, not methods.
function armCalls(value: SyntaxNode): RustRef[] {
  const refs: RustRef[] = [];
  const visit = (node: SyntaxNode) => {
    if (refs.length >= 3) return;
    if (node.type === "call_expression") {
      const callee = node.childForFieldName("function");
      if (callee && (callee.type === "identifier" || callee.type === "scoped_identifier")) {
        const expression = callee.text.replace(/\s+/gu, "");
        if (!NOT_HANDLERS.has(expression)) refs.push({ expression, callee: expression.split("::").at(-1)!, receiver: null });
      }
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(value);
  return refs;
}

// The type of a value: a struct literal, `Type::new(..)` / `Type::default()`,
// `Arc::new(inner)`, or a local or parameter of the enclosing function.
function valueType(node: SyntaxNode, at: SyntaxNode, depth = 0): string | null {
  if (depth > 5) return null;
  switch (node.type) {
    case "struct_expression":
      return rustBaseTypeName(node.childForFieldName("name"));
    case "reference_expression":
    case "parenthesized_expression":
    case "try_expression":
    case "await_expression": {
      const inner = node.childForFieldName("value") ?? node.namedChildren[0];
      return inner ? valueType(inner, at, depth + 1) : null;
    }
    case "call_expression": {
      let callee = node.childForFieldName("function");
      if (callee?.type === "generic_function") callee = callee.childForFieldName("function");
      if (callee?.type === "field_expression") {
        const receiver = callee.childForFieldName("value");
        const method = callee.childForFieldName("field")?.text;
        return receiver && (method === "clone" || method === "unwrap" || method === "expect") ? valueType(receiver, at, depth + 1) : null;
      }
      if (callee?.type !== "scoped_identifier") return null;
      const segments = callee.text.replace(/\s+/gu, "").replace(/::<[^<>]*>/gu, "").split("::");
      const type = segments.at(-2);
      if (!type || !/^[A-Z]/u.test(type)) return null;
      if ((type === "Arc" || type === "Box" || type === "Rc") && segments.at(-1) === "new") {
        const inner = node.childForFieldName("arguments")?.namedChildren[0];
        return inner ? valueType(inner, at, depth + 1) : null;
      }
      return type === "Self" ? selfType(at) : type;
    }
    case "identifier": {
      for (let scope: SyntaxNode | null = at; scope; scope = scope.parent) {
        if (scope.type !== "function_item") continue;
        for (const parameter of scope.childForFieldName("parameters")?.namedChildren ?? []) {
          if (parameter.type === "parameter" && parameter.childForFieldName("pattern")?.text === node.text) {
            const type = parameter.childForFieldName("type")?.text;
            return type ? innerType(type) : null;
          }
        }
        let found: string | null = null;
        for (const declaration of scope.descendantsOfType("let_declaration")) {
          const pattern = declaration.childForFieldName("pattern");
          const name = pattern?.type === "mut_pattern" ? pattern.namedChildren[0]?.text : pattern?.text;
          if (name !== node.text || declaration.startIndex >= node.startIndex) continue;
          const type = declaration.childForFieldName("type")?.text;
          const value = declaration.childForFieldName("value");
          found = type ? innerType(type) : value ? valueType(value, declaration, depth + 1) : null;
        }
        return found;
      }
      return null;
    }
    default:
      return null;
  }
}

function selfType(at: SyntaxNode): string | null {
  for (let parent: SyntaxNode | null = at; parent; parent = parent.parent) {
    if (parent.type === "impl_item") return rustBaseTypeName(parent.childForFieldName("type"));
  }
  return null;
}

export const rustEntrypointsContributor: ISemanticContributor = {
  contribute(graph) {
    const files = graph.nodes.filter((node) => node.label === "File" && (typeof node.properties.rustGrpcServers === "string" || typeof node.properties.rustClap === "string"));
    if (files.length === 0) return;

    const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
    const index = createRustCallIndex(graph, relationshipIndex);
    const newNodes: GraphNode[] = [];
    const newRelationships: GraphRelationship[] = [];
    const usedIds = new Set<string>();
    const add = (fileId: string, id: string, properties: GraphNode["properties"], handlers: string[]) => {
      let unique = id;
      for (let n = 2; usedIds.has(unique); n += 1) unique = `${id}#${n}`;
      usedIds.add(unique);
      newNodes.push({ id: unique, label: "EntryPoint", properties });
      newRelationships.push({ from: fileId, to: unique, type: "DECLARES_ENTRYPOINT", properties: {} });
      for (const to of new Set(handlers)) newRelationships.push({ from: unique, to, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
    };

    // tonic: the methods of each implementation of the served trait.
    const implementations = new Map<string, GraphNode[]>();
    for (const node of graph.nodes) {
      if (node.label !== "Function" || typeof node.properties.implementsTrait !== "string") continue;
      const list = implementations.get(node.properties.implementsTrait) ?? [];
      list.push(node);
      implementations.set(node.properties.implementsTrait, list);
    }
    for (const file of files) {
      if (typeof file.properties.rustGrpcServers !== "string") continue;
      const servers = JSON.parse(file.properties.rustGrpcServers) as GrpcServer[];
      delete file.properties.rustGrpcServers;
      for (const server of servers) {
        const methods = (implementations.get(server.service) ?? []).filter((method) => server.type === null || method.properties.className === server.type);
        for (const method of methods) {
          add(file.id, `${file.id}:entrypoint:${server.line}:${server.column}:grpc:${server.service}/${String(method.properties.name)}`, {
            kind: "grpc",
            trigger: `${server.service}/${String(method.properties.name)}`,
            receiverName: `${server.service}Server`,
            library: "tonic",
            line: server.line,
            handlerName: String(method.properties.name),
          }, [method.id]);
        }
      }
    }

    // clap: types by name across files.
    const clapFiles = files.filter((file) => typeof file.properties.rustClap === "string").map((file) => ({ file, data: JSON.parse(String(file.properties.rustClap)) as ClapFile }));
    for (const { file } of clapFiles) delete file.properties.rustClap;
    const argsTypes = new Map<string, Extract<ClapType, { kind: "args" }>>();
    const subcommands = new Map<string, { type: Extract<ClapType, { kind: "subcommand" }>; fileId: string }>();
    const arms: ClapArm[] = [];
    for (const { file, data } of clapFiles) {
      for (const type of data.types) {
        if (type.kind === "args") argsTypes.set(type.name, type);
        else if (type.kind === "subcommand") subcommands.set(type.name, { type, fileId: file.id });
      }
      arms.push(...data.arms);
    }
    const handlersOf = (match: (arm: ClapArm) => boolean): string[] => {
      const found: string[] = [];
      for (const arm of arms.filter(match)) {
        const fileId = relationshipIndex.fileByFunctionId.get(arm.functionId);
        if (!fileId) continue;
        for (const ref of arm.calls) {
          const call: GraphNode = { id: `${fileId}:cli-arm:${ref.expression}`, label: "Call", properties: { name: ref.expression, expression: ref.expression, callee: ref.callee, receiver: null } };
          const target = resolveRustCall(call, fileId, arm.functionId, index)[0];
          if (target) {
            found.push(target.functionId);
            break;
          }
        }
      }
      return found;
    };

    const emitSubcommands = (enumName: string, prefix: string[], seen: Set<string>) => {
      const entry = subcommands.get(enumName);
      if (!entry || seen.has(enumName)) return;
      for (const variant of entry.type.variants) {
        const path = [...prefix, variant.cliName];
        const nested = variant.subcommandType ?? (variant.fieldType ? argsTypes.get(variant.fieldType)?.subcommandType ?? (subcommands.has(variant.fieldType) ? variant.fieldType : null) : null);
        if (nested && subcommands.has(nested)) {
          emitSubcommands(nested, path, new Set([...seen, enumName]));
          continue;
        }
        add(entry.fileId, `${entry.fileId}:entrypoint:${variant.line}:${variant.column}:cli:${path.join(" ")}`, {
          kind: "cli",
          trigger: path.join(" "),
          receiverName: enumName,
          library: "clap",
          line: variant.line,
          handlerName: variant.name,
        }, handlersOf((arm) => arm.enum === enumName && arm.variant === variant.name));
      }
    };

    for (const { file, data } of clapFiles) {
      const crateName = typeof file.properties.rustCrateName === "string" ? file.properties.rustCrateName : null;
      for (const type of data.types) {
        if (type.kind !== "parser") continue;
        const root = type.cliName ?? crateName ?? kebab(type.name);
        if (type.subcommandType && subcommands.has(type.subcommandType)) {
          emitSubcommands(type.subcommandType, [], new Set());
        } else {
          add(file.id, `${file.id}:entrypoint:${type.line}:${type.column}:cli:${root}`, {
            kind: "cli", trigger: root, receiverName: type.name, library: "clap", line: type.line, handlerName: type.name,
          }, []);
        }
      }
      // The builder's leaves: a command with no subcommand of its own.
      const leaves = data.builders.filter((builder) => !data.builders.some((other) => other.path.length === builder.path.length + 1 && other.path.slice(0, builder.path.length).join("\0") === builder.path.join("\0")));
      for (const builder of leaves) {
        const trigger = builder.path.slice(1).join(" ") || builder.path[0]!;
        const name = builder.path.at(-1)!;
        add(file.id, `${file.id}:entrypoint:${builder.line}:${builder.column}:cli:${builder.path.join(" ")}`, {
          kind: "cli", trigger, receiverName: null, library: "clap", line: builder.line, handlerName: name,
        }, builder.path.length > 1 ? handlersOf((arm) => arm.command === name) : []);
      }
    }

    graph.addNodes(newNodes);
    graph.addRelationships(newRelationships);
  },
};

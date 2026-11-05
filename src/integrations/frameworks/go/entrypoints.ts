import path from "node:path";
import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode, GraphRelationship } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { analyzeMemberCallExpression, walkScoped } from "../../languages/tree-sitter-utils.js";
import { createCallNodes, localTypes, type GoParsePlugin, type LocalType } from "../../languages/go/parser.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { createGoCallIndex, goInterfaceMethodNames, goValueMethods } from "../../../core/scan/resolution/go-calls.js";
import { addClosures, closureFunctionNode } from "./closures.js";
import { importedPackages, reference, type GoHandlerRef } from "./routes.js";
import { resolveRef } from "./route-mounts.js";

// Go entrypoints a framework calls: the methods of a gRPC service
// implementation (`pb.RegisterGreeterServer(s, &server{})`) and cobra
// commands (`&cobra.Command{Use: "serve", RunE: runServe}`). The parse records
// what it sees; the methods, handlers and command paths are resolved once
// every file is parsed.

const GRPC_PACKAGE = "google.golang.org/grpc";
const COBRA_PACKAGE = "github.com/spf13/cobra";

// A gRPC registration, kept on its Call node.
type GrpcRegistration = {
  service: string;
  // The implementation's type, as written or as a constructor's result.
  value: { type?: string; factory?: string };
  importsGrpc: boolean;
  server: string;
};

// A command of the file, kept on the File node: by the variable that holds
// it, and the `parent.AddCommand(child…)` calls.
// A command a function builds and returns is keyed `newServeCmd()`, and
// `var serveCmd = newServeCmd()` is an alias of it.
type CommandTree = {
  commands: Array<{ variable: string; name: string }>;
  edges: Array<{ parent: string; children: string[] }>;
  aliases: Array<{ variable: string; key: string }>;
};

export const goEntrypointsPlugin: GoParsePlugin = ({ fileNodeId, root, nodes, relationships, functions }) => {
  const imports = importedPackages(root);
  const importsGrpc = imports.has(GRPC_PACKAGE);
  const cobra = imports.get(COBRA_PACKAGE);
  const callsById = new Map(nodes.filter((node) => node.label === "Call").map((node) => [node.id, node]));
  const tree: CommandTree = { commands: [], edges: [], aliases: [] };

  const commandLiteral = (literal: SyntaxNode, locals: ReadonlyMap<string, LocalType | null>, enclosing: { id: string; syntax: SyntaxNode } | null, closures: Array<{ node: GraphNode; syntax: SyntaxNode }>) => {
    const fields = new Map<string, SyntaxNode>();
    for (const element of literal.childForFieldName("body")?.namedChildren ?? []) {
      if (element.type !== "keyed_element") continue;
      const [key, value] = element.namedChildren;
      const keyText = key?.type === "literal_element" ? key.namedChildren[0]?.text : key?.text;
      const valueNode = value?.type === "literal_element" ? value.namedChildren[0] : value;
      if (keyText && valueNode) fields.set(keyText, valueNode);
    }
    const use = fields.get("Use");
    const name = use && (use.type === "interpreted_string_literal" || use.type === "raw_string_literal") ? use.text.slice(1, -1).trim().split(/\s+/u)[0] : undefined;
    if (!name) return;
    const local = commandVariable(literal);
    const enclosingName = enclosing ? String(nodes.find((node) => node.id === enclosing.id)?.properties.name ?? "") : "";
    const variable = enclosing && (local === "<return>" || (local !== null && returns(enclosing.syntax, local))) ? `${enclosingName}()` : local === "<return>" ? null : local;
    if (variable) tree.commands.push({ variable, name });

    const run = fields.get("RunE") ?? fields.get("Run");
    if (!run) return;
    const line = literal.startPosition.row + 1;
    const runKey = fields.has("RunE") ? "RunE" : "Run";
    let handler: GoHandlerRef | null;
    let handlerName = run.text;
    if (run.type === "func_literal") {
      const syntheticName = `<${local && local !== "<return>" ? local : name}.${runKey}>`;
      const closure = closureFunctionNode(fileNodeId, run, syntheticName);
      handlerName = syntheticName;
      handler = { expression: syntheticName, callee: syntheticName, receiver: null, functionId: closure.id, scope: "route" };
      if (enclosing) closures.push({ node: closure, syntax: run });
      else if (!nodes.some((node) => node.id === closure.id)) {
        // A package-level command: the parser made no calls for its body.
        nodes.push(closure);
        relationships.push({ from: fileNodeId, to: closure.id, type: "DEFINES_FUNCTION", properties: {} });
        const calls = createCallNodes(closure.id, run, localTypes(run));
        nodes.push(...calls);
        relationships.push(...calls.map((call) => ({ from: closure.id, to: call.id, type: "CALLS" as const, properties: {} })));
      }
    } else {
      handler = { ...reference(run.text, locals), scope: "route" };
    }
    const entrypoint: GraphNode = {
      id: `${fileNodeId}:entrypoint:${line}:${literal.startPosition.column}:cli:${name}`,
      label: "EntryPoint",
      properties: {
        kind: "cli",
        trigger: name,
        receiverName: local && local !== "<return>" ? local : null,
        library: "cobra",
        line,
        handlerName,
        goPending: JSON.stringify({ handler, variable: variable ?? null }),
      },
    };
    nodes.push(entrypoint);
    relationships.push({ from: fileNodeId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} });
  };

  const isCommand = (node: SyntaxNode) => cobra !== undefined && node.type === "composite_literal" && node.childForFieldName("type")?.text === `${cobra}.Command`;

  const visitCalls = (scope: SyntaxNode, functionId: string, locals: ReadonlyMap<string, LocalType | null>) => {
    walkScoped(scope, (node) => {
      if (node.type !== "call_expression") return;
      const callee = node.childForFieldName("function");
      const args = node.childForFieldName("arguments")?.namedChildren ?? [];
      if (!callee) return;
      // `rootCmd.AddCommand(serveCmd, versionCmd)`.
      if (cobra && callee.type === "selector_expression" && callee.childForFieldName("field")?.text === "AddCommand") {
        const parent = callee.childForFieldName("operand");
        const children = args.filter((arg) => arg.type === "identifier").map((arg) => arg.text);
        if (parent?.type === "identifier" && children.length > 0) tree.edges.push({ parent: parent.text, children });
        return;
      }
      const service = /^Register(\w+)Server$/u.exec(analyzeMemberCallExpression(callee.text)?.callee ?? "")?.[1];
      if (!service || args.length !== 2) return;
      const value = implementationValue(args[1]!, locals);
      const call = callsById.get(`${functionId}:call:${node.startPosition.row + 1}:${node.startPosition.column}:${analyzeMemberCallExpression(callee.text)?.expression}`);
      if (!value || !call) return;
      const registration: GrpcRegistration = { service, value, importsGrpc, server: args[0]!.text };
      call.properties.grpcRegistration = JSON.stringify(registration);
    }, (node) => node.type === "func_literal");
  };

  for (const fn of functions) {
    const body = fn.syntax.childForFieldName("body");
    if (!body) continue;
    const locals = localTypes(fn.syntax);
    visitCalls(body, fn.node.id, locals);
    if (!cobra) continue;
    const closures: Array<{ node: GraphNode; syntax: SyntaxNode }> = [];
    walkScoped(body, (node) => {
      if (isCommand(node)) commandLiteral(node, locals, { id: fn.node.id, syntax: fn.syntax }, closures);
    }, () => false);
    addClosures(closures, fn.node.id, fileNodeId, nodes, relationships, callsById);
  }

  if (cobra) {
    for (const declaration of root.namedChildren) {
      if (declaration.type !== "var_declaration") continue;
      walkScoped(declaration, (node) => {
        if (isCommand(node)) commandLiteral(node, new Map(), null, []);
      }, () => false);
      for (const spec of declaration.descendantsOfType("var_spec")) {
        const [name] = spec.childrenForFieldName("name");
        const value = spec.childForFieldName("value")?.namedChildren[0];
        const callee = value?.type === "call_expression" ? value.childForFieldName("function") : null;
        if (name && callee?.type === "identifier") tree.aliases.push({ variable: name.text, key: `${callee.text}()` });
      }
    }
    if (tree.commands.length > 0 || tree.edges.length > 0 || tree.aliases.length > 0) {
      const file = nodes.find((node) => node.id === fileNodeId);
      if (file) file.properties.goCommandTree = JSON.stringify(tree);
    }
  }
};

// The variable a command literal is assigned to (`var serveCmd = &cobra.Command{…}`,
// `cmd := &cobra.Command{…}`), or "<return>" for `return &cobra.Command{…}`.
function commandVariable(literal: SyntaxNode): string | null {
  let node = literal;
  if (node.parent?.type === "unary_expression") node = node.parent;
  const list = node.parent;
  const holder = list?.parent;
  if (list?.type === "return_statement" || (list?.type === "expression_list" && holder?.type === "return_statement")) return "<return>";
  if (list?.type !== "expression_list" || !holder) return null;
  const index = list.namedChildren.findIndex((child) => child.id === node.id);
  const names = holder.type === "var_spec"
    ? holder.childrenForFieldName("name")
    : holder.type === "short_var_declaration" || holder.type === "assignment_statement"
      ? holder.childForFieldName("left")?.namedChildren ?? []
      : [];
  const name = names[index];
  return name?.type === "identifier" ? name.text : null;
}

// Whether the function returns the local `name`.
function returns(fn: SyntaxNode, name: string): boolean {
  let found = false;
  walkScoped(fn, (node) => {
    if (node.type === "return_statement" && node.namedChildren.some((child) => child.text === name || child.namedChildren.some((value) => value.text === name))) found = true;
  }, (node) => node.type === "func_literal");
  return found;
}

// `&server{}`, `server{}`, `new(server)`, a typed local, `svc.New(…)`.
function implementationValue(node: SyntaxNode, locals: ReadonlyMap<string, LocalType | null>): { type?: string; factory?: string } | null {
  if (node.type === "unary_expression" && node.childForFieldName("operator")?.text === "&") return implementationValue(node.childForFieldName("operand")!, locals);
  if (node.type === "composite_literal") {
    const type = node.childForFieldName("type")?.text;
    return type ? { type } : null;
  }
  if (node.type === "identifier") {
    const local = locals.get(node.text);
    return local ? ("type" in local ? { type: local.type } : { factory: local.constructor }) : null;
  }
  if (node.type === "call_expression") {
    const callee = node.childForFieldName("function");
    if (callee?.text === "new") {
      const type = node.childForFieldName("arguments")?.namedChildren[0]?.text;
      return type ? { type } : null;
    }
    return callee && (callee.type === "identifier" || callee.type === "selector_expression") ? { factory: callee.text } : null;
  }
  return null;
}

// gRPC service methods become EntryPoints handled by the implementation's
// methods; cobra commands get their handler and their full command path
// (`app serve`).
export const goEntrypointsContributor: ISemanticContributor = {
  contribute(graph) {
    const registrations = graph.nodes.filter((node) => node.label === "Call" && typeof node.properties.grpcRegistration === "string");
    const commands = graph.nodes.filter((node) => node.label === "EntryPoint" && node.properties.library === "cobra" && typeof node.properties.goPending === "string");
    const trees = graph.nodes.filter((node) => node.label === "File" && typeof node.properties.goCommandTree === "string");
    if (registrations.length === 0 && commands.length === 0 && trees.length === 0) return;

    const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
    const goIndex = createGoCallIndex(graph, relationshipIndex);
    const fileOfFunction = (functionId: string) => relationshipIndex.fileByFunctionId.get(functionId) ?? goIndex.fileByFunctionId.get(functionId) ?? null;
    const functionsById = new Map(graph.nodes.filter((node) => node.label === "Function").map((node) => [node.id, node]));
    const targetsByCall = new Map<string, string[]>();
    for (const relationship of graph.relationships) {
      if (relationship.type === "CALL_RESOLVES_TO") targetsByCall.set(relationship.from, [...targetsByCall.get(relationship.from) ?? [], relationship.to]);
    }

    const newNodes: GraphNode[] = [];
    const newRelationships: GraphRelationship[] = [];
    for (const call of registrations) {
      const registration = JSON.parse(String(call.properties.grpcRegistration)) as GrpcRegistration;
      delete call.properties.grpcRegistration;
      const callerId = relationshipIndex.callerFunctionByCallId.get(call.id);
      const fileId = callerId ? fileOfFunction(callerId) : null;
      if (!fileId) continue;
      // The generated `RegisterXServer(s grpc.ServiceRegistrar, srv XServer)`,
      // when it is in the scan, names the service's methods.
      const target = (targetsByCall.get(call.id) ?? []).map((id) => functionsById.get(id)).find(Boolean);
      const targetFile = target ? fileOfFunction(target.id) : null;
      const parameters = target ? JSON.parse(String(target.properties.parameters ?? "[]")) as Array<{ type: string | null }> : [];
      const generated = parameters[1]?.type?.replace(/^\*/u, "").split(".").pop() === `${registration.service}Server`;
      if (!registration.importsGrpc && !generated) continue;
      const names = targetFile ? goInterfaceMethodNames(targetFile, `${registration.service}Server`, goIndex) : null;
      const methods = goValueMethods(registration.value, fileId, goIndex, names ? [...names].filter((name) => /^[A-Z]/u.test(name)).sort() : undefined);
      const line = Number(call.properties.line);
      for (const method of methods) {
        const entrypoint: GraphNode = {
          id: `${fileId}:entrypoint:${line}:${call.properties.columnNumber}:grpc:${registration.service}/${method.name}`,
          label: "EntryPoint",
          properties: {
            kind: "grpc",
            trigger: `${registration.service}/${method.name}`,
            receiverName: registration.server,
            library: "grpc",
            line,
            handlerName: method.name,
          },
        };
        newNodes.push(entrypoint);
        newRelationships.push(
          { from: fileId, to: entrypoint.id, type: "DECLARES_ENTRYPOINT", properties: {} },
          { from: entrypoint.id, to: method.functionId, type: "ENTRYPOINT_HANDLED_BY", properties: {} },
        );
      }
    }

    // Command paths per package: a child's path is its parent's and its own
    // name.
    const fileByEntrypoint = new Map<string, string>();
    for (const relationship of graph.relationships) {
      if (relationship.type === "DECLARES_ENTRYPOINT") fileByEntrypoint.set(relationship.to, relationship.from);
    }
    const packageOf = (fileId: string) => `${path.posix.dirname(fileId.slice("file:".length).replaceAll("\\", "/"))}\0${graph.nodes.find((node) => node.id === fileId)?.properties.packageName ?? ""}`;
    const namesByPackage = new Map<string, Map<string, string>>();
    const parentsByPackage = new Map<string, Map<string, string>>();
    const aliasesByPackage = new Map<string, Map<string, string>>();
    for (const file of trees) {
      const tree = JSON.parse(String(file.properties.goCommandTree)) as CommandTree;
      delete file.properties.goCommandTree;
      const pkg = packageOf(file.id);
      const names = namesByPackage.get(pkg) ?? new Map<string, string>();
      const parents = parentsByPackage.get(pkg) ?? new Map<string, string>();
      for (const command of tree.commands) names.set(command.variable, command.name);
      for (const edge of tree.edges) for (const child of edge.children) parents.set(child, edge.parent);
      const aliases = aliasesByPackage.get(pkg) ?? new Map<string, string>();
      for (const alias of tree.aliases) aliases.set(alias.key, alias.variable);
      namesByPackage.set(pkg, names);
      parentsByPackage.set(pkg, parents);
      aliasesByPackage.set(pkg, aliases);
    }
    // A parent built by a function (`var rootCmd = newRootCmd()`) has the
    // name of the command that function builds.
    for (const [pkg, aliases] of aliasesByPackage) {
      const names = namesByPackage.get(pkg)!;
      for (const [key, variable] of aliases) if (names.has(key) && !names.has(variable)) names.set(variable, names.get(key)!);
    }
    for (const entrypoint of commands) {
      const pending = JSON.parse(String(entrypoint.properties.goPending)) as { handler: GoHandlerRef | null; variable: string | null };
      delete entrypoint.properties.goPending;
      const fileId = fileByEntrypoint.get(entrypoint.id);
      if (!fileId) continue;
      const pkg = packageOf(fileId);
      const names = namesByPackage.get(pkg);
      const parents = parentsByPackage.get(pkg);
      if (pending.variable && names && parents) {
        const variable = aliasesByPackage.get(pkg)?.get(pending.variable) ?? pending.variable;
        const segments = [String(entrypoint.properties.trigger)];
        const seen = new Set([variable]);
        for (let parent = parents.get(variable); parent && !seen.has(parent) && names.has(parent); parent = parents.get(parent)) {
          seen.add(parent);
          segments.unshift(names.get(parent)!);
        }
        entrypoint.properties.trigger = segments.join(" ");
      }
      const handlerId = pending.handler ? resolveRef(pending.handler, fileId, goIndex) : null;
      if (handlerId) newRelationships.push({ from: entrypoint.id, to: handlerId, type: "ENTRYPOINT_HANDLED_BY", properties: {} });
    }
    graph.addNodes(newNodes);
    graph.addRelationships(newRelationships);
  },
};

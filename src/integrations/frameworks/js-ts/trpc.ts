import type { SyntaxNode } from "../../languages/syntax/tree-sitter.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { JsTsParsedFile } from "../../languages/js-ts/index.js";
import { defaultAndNamedImports } from "./http-clients.js";

// tRPC.
// Server: a router is a top-level `router({…})`, `t.router({…})` or
// `createTRPCRouter({…})` (also default-exported) whose entries are all
// procedures (`publicProcedure.input(…).query(…)`, a chain through a
// `…procedure` ending in `.query` / `.mutation` / `.subscription`), nested
// router calls, or router variables (`user: userRouter`, `{ user }`). Each
// procedure is a `Route` (framework `trpc`, method `QUERY` / `MUTATION` /
// `SUBSCRIPTION`, `path` the dotted path inside its router variable,
// `receiverName` that variable). The router Variable gets `trpcRouter` and,
// for router variables it mounts, `trpcMounts` (`[{ path, name }]`); the
// trpc-routes contributor joins the paths across files into `fullPath`.
// Client: a call `client.user.byId.useQuery(…)` / `.query()` / `.mutate()` /
// `.queryOptions()` / … is a request (`httpClient` `trpc`, `httpMethod` the
// procedure type, `httpUrl` `user.byId`) when `client` is a local bound to
// `useTRPC()` / `useTRPCClient()`, or, recorded as `httpReceiver`, a binding
// the http-requests contributor resolves to a Variable created by
// `createTRPCReact`, `createTRPCNext`, `createTRPCClient`,
// `createTRPCProxyClient`, `createTRPCOptionsProxy` or `createTRPCQueryUtils`
// (`httpClient` `trpc`). `utils.user.byId.fetch()` on
// `const utils = client.useUtils()` (or `useContext()`) counts too.

const procedureTypes = new Map([["query", "QUERY"], ["mutation", "MUTATION"], ["subscription", "SUBSCRIPTION"]]);
const terminals = new Map<string, string>([
  ...["useQuery", "useSuspenseQuery", "useInfiniteQuery", "useSuspenseInfiniteQuery", "usePrefetchQuery", "usePrefetchInfiniteQuery", "query", "queryOptions", "infiniteQueryOptions", "fetch", "prefetch", "fetchInfinite", "prefetchInfinite", "ensureData"].map((name) => [name, "QUERY"] as const),
  ...["useMutation", "mutate", "mutationOptions"].map((name) => [name, "MUTATION"] as const),
  ...["useSubscription", "subscribe", "subscriptionOptions"].map((name) => [name, "SUBSCRIPTION"] as const),
]);
const clientFactory = /^@trpc\/[\w-]+(?:\/[\w-]+)*:(?:createTRPCReact|createTRPCNext|createTRPCClient|createTRPCProxyClient|createTRPCOptionsProxy|createTRPCQueryUtils)$/u;
const routerCallee = /^(?:[A-Za-z_$][\w$]*\.)?router$|^createTRPCRouter$/u;

type Entry = { path: string; kind: "procedure"; method: string; node: SyntaxNode } | { path: string; kind: "mount"; name: string };

export function applyTrpcSemantics({ fileNodeId, rootNode, parsed }: JsTsParsedFile): void {
  const imported = defaultAndNamedImports(parsed.nodes, parsed.relationships, fileNodeId);
  const factories = new Set([...imported].filter(([, from]) => clientFactory.test(from)).map(([name]) => name));
  const hooks = new Set([...imported].filter(([, from]) => /:(?:useTRPC|useTRPCClient)$/u.test(from)).map(([name]) => name));
  const variables = new Map(parsed.nodes.filter((node) => node.label === "Variable").map((node) => [`${node.properties.line}:${node.properties.name}`, node]));

  for (const { name, value, line } of topLevelBindings(rootNode)) {
    const variable = variables.get(`${line}:${name}`);
    if (!variable || value?.type !== "call_expression") continue;
    const callee = value.childForFieldName("function");
    if (callee?.type === "identifier" && factories.has(callee.text)) {
      variable.properties.httpClient = "trpc";
      continue;
    }
    const entries = routerEntries(value, "");
    if (!entries) continue;
    variable.properties.trpcRouter = true;
    const mounts = entries.filter((entry) => entry.kind === "mount").map(({ path, name: mounted }) => ({ path, name: mounted }));
    if (mounts.length > 0) variable.properties.trpcMounts = JSON.stringify(mounts);
    for (const entry of entries) {
      if (entry.kind !== "procedure") continue;
      const routeLine = entry.node.startPosition.row + 1;
      const route: GraphNode = {
        id: `${fileNodeId}:route:${routeLine}:${entry.node.startPosition.column}:${entry.method}:${entry.path}`,
        label: "Route",
        properties: { method: entry.method, path: entry.path, fullPath: entry.path, framework: "trpc", line: routeLine, receiverName: name, handlerName: null },
      };
      parsed.nodes.push(route);
      parsed.relationships.push({ from: fileNodeId, to: route.id, type: "DECLARES_ROUTE", properties: {} });
    }
  }

  // `const trpc = useTRPC()`, `const utils = trpc.useUtils()`, in any scope.
  const clients = new Set<string>();
  const utils = new Map<string, string>();
  const declarators: SyntaxNode[] = [];
  const collect = (node: SyntaxNode) => {
    if (node.type === "variable_declarator") declarators.push(node);
    for (const child of node.namedChildren) if (child) collect(child);
  };
  collect(rootNode);
  for (const declarator of declarators) {
    const name = declarator.childForFieldName("name");
    const value = declarator.childForFieldName("value");
    if (name?.type !== "identifier" || value?.type !== "call_expression") continue;
    const callee = value.childForFieldName("function");
    if (callee?.type === "identifier" && hooks.has(callee.text)) clients.add(name.text);
    const receiver = callee?.type === "member_expression" ? callee.childForFieldName("object") : null;
    const member = callee?.type === "member_expression" ? callee.childForFieldName("property")?.text : undefined;
    if (receiver?.type === "identifier" && (member === "useUtils" || member === "useContext")) utils.set(name.text, receiver.text);
  }

  const callsByPosition = new Map<string, GraphNode>();
  for (const node of parsed.nodes) {
    if (node.label === "Call") callsByPosition.set(`${node.properties.line}:${node.properties.columnNumber}`, node);
  }
  const visit = (node: SyntaxNode) => {
    if (node.type === "call_expression") {
      const chain = memberChain(node.childForFieldName("function"));
      const method = chain ? terminals.get(chain.members.at(-1)!) : undefined;
      const call = method ? callsByPosition.get(`${node.startPosition.row + 1}:${node.startPosition.column}`) : undefined;
      if (chain && method && call && call.properties.httpMethod === undefined) {
        let root = chain.root;
        let segments = chain.members.slice(0, -1);
        const utilsOf = utils.get(root);
        if (utilsOf !== undefined) {
          root = utilsOf;
          if (segments[0] === "client") segments = segments.slice(1);
        }
        if (segments.length > 0) {
          if (clients.has(root)) call.properties.httpClient = "trpc";
          else call.properties.httpReceiver = root;
          call.properties.httpMethod = method;
          call.properties.httpUrl = segments.join(".");
        }
      }
    }
    for (const child of node.namedChildren) if (child) visit(child);
  };
  visit(rootNode);
}

function topLevelBindings(root: SyntaxNode): Array<{ name: string; value: SyntaxNode | null; line: number }> {
  const bindings: Array<{ name: string; value: SyntaxNode | null; line: number }> = [];
  for (const statement of root.namedChildren) {
    if (!statement) continue;
    const declaration = statement.type === "export_statement" ? statement.childForFieldName("declaration") : statement;
    if (declaration?.type === "lexical_declaration" || declaration?.type === "variable_declaration") {
      for (const declarator of declaration.namedChildren) {
        const name = declarator?.type === "variable_declarator" ? declarator.childForFieldName("name") : null;
        if (name?.type === "identifier") bindings.push({ name: name.text, value: unwrap(declarator!.childForFieldName("value")), line: declarator!.startPosition.row + 1 });
      }
    } else if (statement.type === "export_statement" && statement.children.some((child) => child?.type === "default")) {
      bindings.push({ name: "default", value: unwrap(statement.childForFieldName("value")), line: statement.startPosition.row + 1 });
    }
  }
  return bindings;
}

// `x as T`, `x satisfies T`, `(x)`.
function unwrap(node: SyntaxNode | null): SyntaxNode | null {
  while (node && (node.type === "as_expression" || node.type === "satisfies_expression" || node.type === "parenthesized_expression")) {
    node = node.namedChildren[0] ?? null;
  }
  return node;
}

// The entries of a router call, null when it is not one.
function routerEntries(call: SyntaxNode, prefix: string): Entry[] | null {
  const callee = call.childForFieldName("function")?.text ?? "";
  const object = call.childForFieldName("arguments")?.namedChildren[0];
  if (!routerCallee.test(callee) || object?.type !== "object") return null;
  const entries: Entry[] = [];
  for (const entry of object.namedChildren) {
    if (!entry || entry.type === "comment") continue;
    if (entry.type === "shorthand_property_identifier") {
      entries.push({ path: `${prefix}${entry.text}`, kind: "mount", name: entry.text });
      continue;
    }
    if (entry.type !== "pair") return null;
    const key = entry.childForFieldName("key");
    const name = key?.type === "string" ? key.text.slice(1, -1) : key?.type === "property_identifier" ? key.text : null;
    const value = unwrap(entry.childForFieldName("value"));
    if (!name || !value) return null;
    const path = `${prefix}${name}`;
    const method = value.type === "call_expression" ? procedureType(value) : null;
    if (method) {
      entries.push({ path, kind: "procedure", method, node: value });
    } else if (value.type === "identifier") {
      entries.push({ path, kind: "mount", name: value.text });
    } else {
      const nested = value.type === "call_expression" ? routerEntries(value, `${path}.`) : null;
      if (!nested) return null;
      entries.push(...nested);
    }
  }
  return entries.length > 0 ? entries : null;
}

// `publicProcedure.input(schema).query(resolver)` → QUERY.
function procedureType(call: SyntaxNode): string | null {
  const callee = call.childForFieldName("function");
  if (callee?.type !== "member_expression") return null;
  const type = procedureTypes.get(callee.childForFieldName("property")?.text ?? "");
  return type && /procedure/iu.test(callee.childForFieldName("object")?.text ?? "") ? type : null;
}

// `a.b.c` → root `a`, members `[b, c]`.
function memberChain(node: SyntaxNode | null): { root: string; members: string[] } | null {
  const members: string[] = [];
  while (node?.type === "member_expression") {
    members.unshift(node.childForFieldName("property")?.text ?? "");
    node = node.childForFieldName("object");
  }
  return node?.type === "identifier" && members.length > 1 ? { root: node.text, members } : null;
}

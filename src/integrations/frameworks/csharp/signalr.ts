import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import type { GraphNode } from "../../../core/graph/model.js";
import type { GraphSchemaExtension } from "../../../core/graph/schema.js";
import type { VersionedCSharpParsePlugin } from "../../languages/csharp/parser.js";
import type { CSharpType } from "../../languages/csharp/types.js";
import { csharpAttributeReader, csharpStringLiteral, argumentExpression, findAttributes } from "./attributes.js";
import { addCSharpEntryPoint } from "./emit.js";
import { invocationInfo } from "./invocations.js";
import { createGroupPrefixResolver, describePath } from "./routes.js";
import { csharpMethods } from "./shared.js";
import { csharpTypeResolver } from "./type-names.js";

// SignalR hubs. A concrete class deriving from `Hub` / `Hub<TClient>` / `DynamicHub` (directly or through a user base
// class) is a hub; every public, non-static, non-override instance method of it, own or inherited from a scanned
// base, is invocable by clients: an EntryPoint (kind `signalr`, library `signalr`, trigger `Hub/method`; the name is
// `[HubMethodName("x")]` when written). Overrides are the framework callbacks (`OnConnectedAsync`,
// `OnDisconnectedAsync`, `Dispose`): not client-invokable, so not entrypoints. Abstract hubs have no instance: their
// concrete subclasses carry the methods. `MapHub<T>("/path")` gives the EntryPoints `hubPath` (the first call's path;
// null when no call names the hub or the path is not a literal); the `MapGroup` prefixes of the receiver chain or of the local
// variable holding a group (`app.MapGroup("/rt").MapHub<T>("/chat")`) are joined in front, reusing the minimal API group logic
// of routes.ts (a prefix that is not a literal gives null, never a guess).

const SIGNALR_NAMESPACES = ["Microsoft.AspNetCore.SignalR"];
const HUB_BASES = ["Hub", "DynamicHub"];

// MapHub<T>("/path"): the literal path (null when it is a constant, an expression or absent), stored on the Call node
// for the contributor, which removes it.
export const csharpSignalrPlugin: VersionedCSharpParsePlugin = Object.assign(
  ({ root, functions, calls }: Parameters<VersionedCSharpParsePlugin>[0]) => {
    if (!root.text.includes("MapHub")) return;
    const groupPrefix = createGroupPrefixResolver(functions);
    for (const { syntax, node, function: fn } of calls) {
      if (node.properties.callee !== "MapHub") continue;
      const info = invocationInfo(syntax);
      if (!info || info.name !== "MapHub") continue;
      const first = info.arguments[0];
      let path: string | null = null;
      if (first?.kind === "string") {
        const nameNode = syntax.childForFieldName("function")?.childForFieldName("name") ?? syntax;
        const parts = [...groupPrefix(info.receiver, fn, nameNode.startPosition.row + 1), { value: first.value ?? "", resolved: true }];
        path = describePath(parts).path;
      }
      node.properties.signalrMapHub = JSON.stringify({ path });
    }
  },
  { version: "2" },
);

export const csharpSignalrContributor: ISemanticContributor = {
  id: "csharp.signalr",
  contribute(graph) {
    const resolver = csharpTypeResolver(graph);
    const attributes = csharpAttributeReader(graph);
    const methods = csharpMethods(graph);
    const fileOfFunction = new Map(methods.map((method) => [method.node.id, method.fileId]));

    const hubPaths = new Map<string, string | null>();
    for (const call of graph.nodesWithLabel("Call")) {
      const raw = call.properties.signalrMapHub;
      if (typeof raw !== "string") continue;
      delete call.properties.signalrMapHub;
      if (typeof call.properties.typeArguments !== "string") continue;
      const resolved = resolver.resolve(String(call.properties.typeArguments).split(",")[0]!.trim(), call);
      if (!resolved) continue;
      const path = (JSON.parse(raw) as { path: string | null }).path;
      if (!hubPaths.has(resolved.id) || (hubPaths.get(resolved.id) === null && path !== null)) hubPaths.set(resolved.id, path);
    }

    const classChain = (type: CSharpType): CSharpType[] => {
      const chain: CSharpType[] = [];
      const seen = new Set<string>();
      for (let current: CSharpType | undefined = type; current && !seen.has(current.id); current = resolver.index.supertypes(current).find((parent) => parent.node.label === "Class")) {
        seen.add(current.id);
        chain.push(current);
      }
      return chain;
    };
    const isInvocable = (fn: GraphNode): boolean =>
      fn.properties.kind === "method" && fn.properties.methodKind !== "primary" && fn.properties.visibility === "public" && fn.properties.isStatic !== true && fn.properties.isOverride !== true;

    for (const type of resolver.index.types) {
      const cls = type.node;
      if (cls.label !== "Class" || cls.properties.kind !== "class" || cls.properties.isAbstract === true || cls.properties.isStatic === true) continue;
      if (!resolver.derivesFromExternal(type, HUB_BASES)) continue;
      const hubName = type.name;
      const path = hubPaths.get(type.id) ?? null;
      const taken = new Set<string>();
      for (const owner of classChain(type)) {
        for (const fn of resolver.methodsOf(owner)) {
          const name = String(fn.properties.name);
          if (taken.has(name) || !isInvocable(fn)) continue;
          taken.add(name);
          const fileId = fileOfFunction.get(fn.id);
          if (!fileId) continue;
          let hubMethod = name;
          const renamed = findAttributes(attributes.attributesOf(fn), "HubMethodName", SIGNALR_NAMESPACES)[0];
          if (renamed) {
            const written = csharpStringLiteral(argumentExpression(renamed, 0, "name") ?? "");
            if (written) hubMethod = written;
          }
          const entry = addCSharpEntryPoint(graph, { fileId, kind: "signalr", trigger: `${hubName}/${hubMethod}`, line: Number(fn.properties.line), handler: fn, library: "signalr" });
          entry.properties.hubPath = path;
        }
      }
    }
  },
};

// `hubPath` on the signalr EntryPoints: the `MapHub<T>("/path")` path.
export const csharpSignalrSchema: GraphSchemaExtension = {
  id: "csharp-signalr",
  nodeProperties: [{ label: "EntryPoint", after: "handlerName", properties: { hubPath: "STRING" } }],
};

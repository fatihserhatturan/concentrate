import type { GraphNode } from "../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../core/contracts/semantic-contributor.js";
import { createResolutionRelationshipIndex } from "../../../core/scan/resolution/indexes.js";
import { firstResultType } from "../../../core/scan/resolution/go-calls.js";
import { createGoParser } from "../../languages/go/parser.js";
import { createGoRoutesPlugin, routerPackages, routerTypeOf, type GoForeignRouter, type GoRouteFramework } from "./routes.js";

// A router another package builds (`r := router.New()`, where router.New
// returns `*echo.Echo`): the parse of the calling file cannot know it is one
// (the file may not even import echo), so once every file is parsed, each Go
// file that calls such a function is parsed again with the callee marked as a
// router constructor, and the routes, closures and router arguments that parse
// finds are added. Ids are positions, so the routes and closures of the first
// parse come back with the same ids and are kept as they are. Runs before goRoutesContributor,
// which finishes them like any other.
export const goForeignRoutersContributor: ISemanticContributor = {
  async contribute(graph, rootPath) {
    const relationshipIndex = createResolutionRelationshipIndex(graph.relationships);
    const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
    const importsByFile = new Map<string, Map<GoRouteFramework, string>>();
    for (const node of graph.nodes) {
      if (node.label !== "Import" || typeof node.properties.source !== "string") continue;
      const fileId = relationshipIndex.fileByImportId.get(node.id);
      const framework = routerPackages.find(([, pattern]) => pattern.test(String(node.properties.source)))?.[0];
      if (!fileId || !framework) continue;
      const alias = typeof node.properties.alias === "string" ? node.properties.alias : defaultName(String(node.properties.source));
      if (alias === "_" || alias === ".") continue;
      const aliases = importsByFile.get(fileId) ?? new Map<GoRouteFramework, string>();
      aliases.set(framework, alias);
      importsByFile.set(fileId, aliases);
    }
    // Functions that return a router.
    const constructors = new Map<string, GoForeignRouter>();
    for (const node of graph.nodes) {
      if (node.label !== "Function" || node.properties.className != null) continue;
      const fileId = relationshipIndex.fileByFunctionId.get(node.id);
      const aliases = fileId ? importsByFile.get(fileId) : undefined;
      const result = aliases ? firstResultType(node.properties.returnType) : null;
      const type = result ? routerTypeOf(result, aliases!) : null;
      if (type) constructors.set(node.id, type);
    }
    if (constructors.size === 0) return;

    const hintsByFile = new Map<string, Map<string, GoForeignRouter>>();
    for (const rel of graph.relationships) {
      const type = rel.type === "CALL_RESOLVES_TO" ? constructors.get(rel.to) : undefined;
      const call = type ? nodeById.get(rel.from) : undefined;
      const callerFunctionId = call ? relationshipIndex.callerFunctionByCallId.get(call.id) : undefined;
      const fileId = callerFunctionId ? relationshipIndex.fileByFunctionId.get(callerFunctionId) : undefined;
      if (!call || !fileId || relationshipIndex.fileByFunctionId.get(rel.to) === fileId) continue;
      const hints = hintsByFile.get(fileId) ?? new Map<string, GoForeignRouter>();
      hints.set(String(call.properties.expression), type!);
      hintsByFile.set(fileId, hints);
    }

    const relationshipKeys = new Set(graph.relationships.map((rel) => `${rel.from}\0${rel.type}\0${rel.to}`));
    for (const [fileId, hints] of hintsByFile) {
      const file = nodeById.get(fileId);
      const filePath = file?.properties.path;
      if (typeof filePath !== "string") continue;
      let parsed;
      try {
        parsed = await createGoParser([createGoRoutesPlugin(hints)]).parse(rootPath, filePath);
      } catch {
        continue;
      }
      const added: GraphNode[] = [];
      for (const node of parsed.nodes) {
        const existing = nodeById.get(node.id);
        if (!existing) {
          added.push(node);
          nodeById.set(node.id, node);
          continue;
        }
        if (node.label === "Call" && typeof node.properties.routerArguments === "string") existing.properties.routerArguments = node.properties.routerArguments;
        if (node.label === "File" && typeof node.properties.dynamicRouteCalls === "string") existing.properties.dynamicRouteCalls = node.properties.dynamicRouteCalls;
      }
      graph.addNodes(added);
      const closures = new Set(added.filter((node) => node.label === "Function").map((node) => node.id));
      for (const rel of parsed.relationships) {
        // A call in a closure handler moves from the enclosing function to it.
        if (rel.type === "CALLS" && closures.has(rel.from)) {
          const moved = graph.relationships.find((existing) => existing.type === "CALLS" && existing.to === rel.to);
          if (moved) moved.from = rel.from;
          continue;
        }
        const key = `${rel.from}\0${rel.type}\0${rel.to}`;
        if (relationshipKeys.has(key) || !nodeById.has(rel.from) || !nodeById.has(rel.to)) continue;
        relationshipKeys.add(key);
        graph.addRelationship(rel);
      }
    }
  },
};

function defaultName(source: string): string {
  const parts = source.split("/");
  const last = parts[parts.length - 1]!;
  return /^v\d+$/u.test(last) && parts.length > 1 ? parts[parts.length - 2]! : last;
}

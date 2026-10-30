import type { GraphNode } from "../../../../core/graph/model.js";
import type { ISemanticContributor } from "../../../../core/contracts/semantic-contributor.js";
import { createVariableResolver } from "./variable-resolver.js";

// The full dotted path of each tRPC procedure: the paths of the router
// variables that mount its router (`user: userRouter`, in the same file or
// imported), outermost first, then its path inside its router. A router
// mounted by more than one router has no single path; its procedures get a
// null `fullPath` and are not linked. A router nobody mounts is a root.
export const trpcRoutesContributor: ISemanticContributor = {
  contribute(graph) {
    const routes = graph.nodes.filter((node) => node.label === "Route" && node.properties.framework === "trpc");
    if (routes.length === 0) return;
    const { variableOf, fileByVariableId } = createVariableResolver(graph.nodes, graph.relationships);

    const parents = new Map<string, Array<{ parent: GraphNode; path: string }>>();
    for (const router of graph.nodes) {
      if (router.label !== "Variable" || router.properties.trpcRouter !== true || typeof router.properties.trpcMounts !== "string") continue;
      const fileId = fileByVariableId.get(router.id);
      if (!fileId) continue;
      for (const { path, name } of JSON.parse(router.properties.trpcMounts) as Array<{ path: string; name: string }>) {
        const child = variableOf(name, fileId);
        if (child?.properties.trpcRouter !== true) continue;
        parents.set(child.id, [...(parents.get(child.id) ?? []), { parent: router, path }]);
      }
    }
    const prefixes = new Map<string, string | null>();
    const prefixOf = (router: GraphNode, seen: Set<string>): string | null => {
      if (prefixes.has(router.id)) return prefixes.get(router.id)!;
      if (seen.has(router.id)) return null;
      seen.add(router.id);
      const mountedBy = parents.get(router.id) ?? [];
      const outer = mountedBy.length === 1 ? prefixOf(mountedBy[0]!.parent, seen) : null;
      const prefix = mountedBy.length === 0 ? "" : outer === null ? null : `${outer}${mountedBy[0]!.path}.`;
      prefixes.set(router.id, prefix);
      return prefix;
    };

    const fileByRouteId = new Map(graph.relationships.filter((rel) => rel.type === "DECLARES_ROUTE").map((rel) => [rel.to, rel.from]));
    for (const route of routes) {
      const fileId = fileByRouteId.get(route.id);
      const router = fileId && typeof route.properties.receiverName === "string" ? variableOf(route.properties.receiverName, fileId) : undefined;
      const prefix = router ? prefixOf(router, new Set()) : null;
      route.properties.fullPath = prefix === null ? null : `${prefix}${route.properties.path}`;
    }
  },
};

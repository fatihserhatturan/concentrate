import type { GraphProperties, GraphRelationship } from "../../core/graph/model.js";

// How a relationship was resolved, in one vocabulary the tools can return:
//   exact      resolved through scope, imports or a literal match
//   framework  linked by a framework rule (gRPC stub to handler, Celery task,
//              Qt signal to slot, C macro)
//   inferred   one of the candidates of a dispatch through a type relationship
//              (interface method, override, trait method) or a catch-all
//   by-name    matched on a name alone (CSS class to a style of that name)
// The store stamps it when it writes, from the `via` and `match` properties
// the resolvers already set, so every writer of those relationships is covered.
export type Provenance = "exact" | "framework" | "inferred" | "by-name";

const FRAMEWORK_VIA = new Set(["grpc", "celery", "qt", "macro"]);

export function provenanceOf(relationship: Pick<GraphRelationship, "type" | "properties">): Provenance | null {
  const { via, match } = relationship.properties;
  switch (relationship.type) {
    case "CALL_RESOLVES_TO":
      if (typeof via !== "string") return "exact";
      return FRAMEWORK_VIA.has(via) ? "framework" : "inferred";
    case "REQUESTS":
    case "NAVIGATES_TO":
      return match === "catch-all" ? "inferred" : "exact";
    case "USES_STYLE":
      return match === "import" || match === "name" ? "by-name" : "exact";
    default:
      return null;
  }
}

export function withProvenance(relationship: GraphRelationship): GraphProperties {
  const provenance = provenanceOf(relationship);
  return provenance ? { ...relationship.properties, provenance } : relationship.properties;
}

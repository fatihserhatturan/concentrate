// Relationship types grouped into the few kinds the interface filters by.
export const EDGE_KINDS = ["imports", "calls", "routes", "data", "renders", "requests", "types", "di", "env", "other"] as const;
export type EdgeKind = (typeof EDGE_KINDS)[number] | "defines";

const DEFINING = /^(DEFINES_|DECLARES_|HAS_DECORATOR|HAS_METHOD_DECORATOR|ENUM_HAS_DECORATOR|INTERFACE_HAS_DECORATOR|CONTAINS_|CONTAINS_ROOT|HAS_PACKAGE|PACKAGE_CONTAINS_FILE|MODULE_CALLS|CALLS$|PASSED_TO|INITIALIZED_BY|IMPORTS$|RE_EXPORTS$)/;

/** Kind of a stored relationship type; structural ones (containment, ownership) are `defines`. */
export function kindOf(type: string): EdgeKind {
  if (type === "RESOLVES_TO" || type === "IMPORTS_PACKAGE" || type === "PACKAGE_IMPORTS_PACKAGE" || type.startsWith("RE_EXPORTS_")) return "imports";
  if (type === "CALL_RESOLVES_TO" || type === "DEFINED_BY" || type === "SIGNAL_CONNECTS_TO" || type === "USES_HOOK") return "calls";
  if (type === "ROUTE_HANDLED_BY" || type === "ROUTE_LIFECYCLE_STEP" || type === "MOUNTS_VARIABLE" || type === "MOUNTS_FUNCTION" || type === "ENTRYPOINT_HANDLED_BY" || type === "PAGE_LOADS" || type === "RPC_IMPLEMENTED_BY" || type === "RPC_SERVED_BY" || type === "HAS_RPC" || type === "RPC_REQUEST" || type === "RPC_RESPONSE") return "routes";
  if (type.startsWith("ACCESSES_DATA_") || type.startsWith("READS_") && type !== "READS_STORE" || type.startsWith("WRITES_") && type !== "WRITES_STORE" || type === "MAPS_TO_TABLE" || type === "RELATES_TO") return "data";
  if (type === "RENDERS" || type === "PAGE_RENDERS" || type === "USES_CONTEXT" || type.startsWith("COMPONENT_DEFINED_BY") || type === "READS_STORE" || type === "WRITES_STORE" || type === "STORE_ACTION" || type === "STORE_DEFINED_BY_FUNCTION" || type.startsWith("USES_STYLE_") || type === "SELECTS_STYLE") return "renders";
  if (type === "REQUESTS") return "requests";
  if (type === "EXTENDS" || type === "IMPLEMENTS") return "types";
  if (type === "INJECTS" || type.startsWith("MODULE_")) return "di";
  if (type.startsWith("USES_ENV_") || type === "DECLARES_ENV" || type.includes("CONFIG") || type.startsWith("RUNS_")) return "env";
  if (type === "LIFECYCLE_PRECEDES") return "routes";
  return DEFINING.test(type) ? "defines" : "other";
}

/** Intermediate nodes the interface never draws; edges through them are collapsed. */
export const HIDDEN_LABELS = new Set(["Call", "Import", "Decorator", "Field"]);

/** Labels that are containers in the overview. */
export const CONTAINER_LABELS = new Set(["Repo", "Package", "Directory", "File"]);

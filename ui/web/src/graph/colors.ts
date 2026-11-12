export const LABEL_COLORS: Record<string, string> = {
  Package: "#8250df", Directory: "#bf8700", File: "#0969da", Function: "#1a7f37", Class: "#cf222e", Interface: "#bc4c00",
  TypeAlias: "#6e7781", Enum: "#9a6700", Variable: "#57606a", Route: "#d1242f", EntryPoint: "#fb8500", EnvVar: "#116329",
  ConfigValue: "#4d2d00", DataModel: "#0a3069", Table: "#0550ae", Component: "#a475f9", Page: "#bf3989", Store: "#1f883d",
  Style: "#e16f24", Service: "#953800", Rpc: "#7d4e00", Message: "#6639ba",
};
export const color = (label: string) => LABEL_COLORS[label] ?? "#6e7781";

export const EDGE_KIND_COLORS: Record<string, string> = {
  imports: "#0969da", calls: "#1a7f37", routes: "#d1242f", data: "#8250df", renders: "#bf3989", requests: "#fb8500",
  types: "#bc4c00", di: "#6e7781", env: "#116329", defines: "#b6bcc4", other: "#8c959f",
};
export const EDGE_KIND_LABELS: Record<string, string> = {
  imports: "imports", calls: "calls", routes: "routes and handlers", data: "data access", renders: "renders, stores, styles",
  requests: "frontend requests", types: "extends / implements", di: "dependency injection", env: "env and config", defines: "declarations (structure)",
};

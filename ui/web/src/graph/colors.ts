export { LABEL_COLORS, color } from "../../../shared/palette.js";

export const EDGE_KIND_COLORS: Record<string, string> = {
  imports: "#0969da", calls: "#1a7f37", routes: "#d1242f", data: "#8250df", renders: "#bf3989", requests: "#fb8500",
  types: "#bc4c00", di: "#6e7781", env: "#116329", defines: "#b6bcc4", other: "#8c959f",
};
export const EDGE_KIND_LABELS: Record<string, string> = {
  imports: "imports", calls: "calls", routes: "routes and handlers", data: "data access", renders: "renders, stores, styles",
  requests: "frontend requests", types: "extends / implements", di: "dependency injection", env: "env and config", defines: "declarations (structure)",
};

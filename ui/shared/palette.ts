// One colour per node kind, used by the graph screen and by the HTML export so both look the same.
export const LABEL_COLORS: Record<string, string> = {
  Package: "#8250df", Directory: "#bf8700", File: "#0969da", Function: "#1a7f37", Class: "#cf222e", Interface: "#bc4c00",
  TypeAlias: "#6e7781", Enum: "#9a6700", Variable: "#57606a", Route: "#d1242f", EntryPoint: "#fb8500", EnvVar: "#116329",
  ConfigValue: "#4d2d00", DataModel: "#0a3069", Table: "#0550ae", Component: "#a475f9", Page: "#bf3989", Store: "#1f883d",
  Style: "#e16f24", Service: "#953800", Rpc: "#7d4e00", Message: "#6639ba",
};
export const FALLBACK_COLOR = "#6e7781";
export const color = (label: string): string => LABEL_COLORS[label] ?? FALLBACK_COLOR;

/** Relationship colours of the export's viewer (the screen takes the same ones from its theme tokens). */
export const EDGE_COLORS: Record<string, string> = {
  imports: "#0969da", calls: "#cf222e", routes: "#8250df", requests: "#8250df", renders: "#8250df", data: "#1a7f37", env: "#1a7f37",
  types: "#cf222e", di: "#cf222e", other: "#cf222e", defines: "#8c959f",
};

import { Icon, type IconName } from "./icons.js";

// One glyph per node kind: a shape or letter, in a neutral colour, so a kind is told apart without colour.
const ICONS: Record<string, IconName> = {
  Directory: "folder", Package: "folder", File: "file", Route: "route", Table: "table", DataModel: "table",
  Component: "component", Page: "component", EnvVar: "env", EntryPoint: "entry", Store: "table",
};
const LETTERS: Record<string, string> = {
  Function: "ƒ", Class: "C", Interface: "I", TypeAlias: "T", Enum: "E", Variable: "v", Service: "S", Rpc: "R", Message: "M", Style: "#", ConfigValue: "=",
};

export function KindGlyph({ label, size = 14 }: { label: string; size?: number }) {
  const icon = ICONS[label];
  if (icon) return <Icon name={icon} width={size} height={size} />;
  return <span class="glyph-letter" style={{ width: size, height: size, fontSize: size - 3 }} aria-hidden="true">{LETTERS[label] ?? label.slice(0, 1)}</span>;
}

/** SVG version for the layered graph, where HTML cannot go. */
export function KindGlyphSvg({ label, x, y }: { label: string; x: number; y: number }) {
  const icon = ICONS[label];
  if (icon) return <g transform={`translate(${x},${y})`} class="glyph"><Icon name={icon} width={14} height={14} x={0} y={0} /></g>;
  return <text class="glyph-svg" x={x + 7} y={y + 11.5} text-anchor="middle">{LETTERS[label] ?? label.slice(0, 1)}</text>;
}

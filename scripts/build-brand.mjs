// Writes the brand SVGs (wordmark, logo, icon) of docs/assets/brand and the UI favicon.
// Run: node scripts/build-brand.mjs
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const out = path.join(import.meta.dirname, "..", "docs", "assets", "brand");
mkdirSync(out, { recursive: true });

const STROKE = 5;
const NODE = 4.4;

// Letter strokes on one grid: x-height 24..60, round letters r=18.
const strokes = [
  "M30.7 29.3A18 18 0 1 0 30.7 54.7", // c
  "M91 60L91 24M91 42A16 18 0 0 1 123 42L123 60", // n
  "M165.7 29.3A18 18 0 1 0 165.7 54.7", // c
  "M178 42L214 42A18 18 0 1 0 208.7 54.7", // e
  "M226 60L226 24M226 42A16 18 0 0 1 258 42L258 60", // n
  "M276 10L276 48Q276 60 288 60L290 60M266 24L290 24", // t
  "M302 60L302 24M302 42A20 18 0 0 1 322 24", // r
  "M368 24L368 60", // a stem
  "M388 10L388 48Q388 60 400 60L402 60M378 24L402 24", // t
  "M414 42L450 42A18 18 0 1 0 444.7 54.7", // e
];
const rings = [[61, 42], [350, 42]]; // o, a bowl
// Nodes only where a stroke ends; the o keeps its centre.
const nodes = [
  [30.7, 29.3], [30.7, 54.7],
  [91, 24], [91, 60], [123, 60],
  [165.7, 29.3], [165.7, 54.7],
  [208.7, 54.7],
  [226, 24], [226, 60], [258, 60],
  [276, 10], [290, 60],
  [302, 24], [302, 60], [322, 24],
  [368, 24], [368, 60],
  [388, 10], [402, 60],
  [444.7, 54.7],
];
const CENTER = [61, 42];

function wordmarkBody(ink, amber) {
  return [
    `<g fill="none" stroke="${ink}" stroke-width="${STROKE}" stroke-linecap="round" stroke-linejoin="round">`,
    ...rings.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="18"/>`),
    ...strokes.map((d) => `<path d="${d}"/>`),
    "</g>",
    `<g fill="${amber}">`,
    `<circle cx="${CENTER[0]}" cy="${CENTER[1]}" r="5"/>`,
    ...nodes.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="${NODE}"/>`),
    "</g>",
  ].join("");
}

// Icon on a 56 grid: a ring around one node, three edges out to three nodes.
function iconBody(tile, glyph, dot = glyph) {
  return [
    `<rect width="56" height="56" rx="14" fill="${tile}"/>`,
    `<g fill="none" stroke="${glyph}" stroke-width="3.5" stroke-linecap="round"><circle cx="28" cy="28" r="10"/><path d="M20.5 21.4L10 12M35.9 21.9L46 14M33.6 36.3L40 46"/></g>`,
    `<g fill="${dot}"><circle cx="28" cy="28" r="3.6"/><circle cx="10" cy="12" r="3.6"/><circle cx="46" cy="14" r="3.6"/><circle cx="40" cy="46" r="3.6"/></g>`,
  ].join("");
}

const svg = (viewBox, width, height, title, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}" width="${width}" height="${height}" role="img" aria-label="${title}"><title>${title}</title>${body}</svg>\n`;

const themes = {
  dark: { ink: "#F4EFE6", amber: "#FF9A2E" },
  light: { ink: "#1A1613", amber: "#D2640A" },
};
const TILE = "#FF9A2E";
const GLYPH = "#14110F";

for (const [name, { ink, amber }] of Object.entries(themes)) {
  writeFileSync(path.join(out, `wordmark-${name}.svg`), svg("-6 0 467 70", 467, 70, "Concentrate", wordmarkBody(ink, amber)));
  writeFileSync(
    path.join(out, `logo-${name}.svg`),
    svg("0 0 543 70", 543, 70, "Concentrate", `<g transform="translate(0 7)">${iconBody(TILE, GLYPH)}</g><g transform="translate(82 0)">${wordmarkBody(ink, amber)}</g>`),
  );
}
writeFileSync(path.join(out, "icon.svg"), svg("0 0 56 56", 256, 256, "Concentrate", iconBody(TILE, GLYPH)));
writeFileSync(
  path.join(out, "icon-16.svg"),
  svg("0 0 16 16", 16, 16, "Concentrate", `<rect width="16" height="16" rx="4" fill="${TILE}"/><circle cx="8" cy="8" r="4.4" fill="none" stroke="${GLYPH}" stroke-width="1.6"/><circle cx="8" cy="8" r="1.7" fill="${GLYPH}"/>`),
);

copyFileSync(path.join(out, "icon.svg"), path.join(import.meta.dirname, "..", "ui", "web", "public", "favicon.svg"));

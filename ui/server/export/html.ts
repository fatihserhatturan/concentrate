import { nodeName, type IndexNode } from "../graph/index.js";
import { HIDDEN_LABELS, kindOf } from "../graph/kinds.js";
import { clusterOf } from "../../shared/clusters.js";
import { EDGE_COLORS, LABEL_COLORS } from "../../shared/palette.js";
import { seedLayout } from "../../shared/seed-layout.js";
import { escapeXml } from "./xml.js";
import { VIEWER_CSS, VIEWER_JS } from "./viewer.js";
import type { Selection } from "./select.js";

export const HTML_NODE_CAP = 5000;

type DataNode = { id: string; l: string; n: string; f: string | null; line: number | null; g: string; d: number; x: number; y: number };

/**
 * One self-contained HTML file: viewer script and graph data inlined, no network.
 * Above the node cap the selection is the file-level graph (the aggregated level)
 * and each file carries its declarations as detail.
 */
export function htmlDocument(full: Selection, aggregated: Selection | null): string {
  const useAggregated = aggregated !== null;
  const selection = aggregated ?? full;
  const visible = selection.nodes.filter((n) => !HIDDEN_LABELS.has(n.label));
  const idx = selection.index;
  const nodes: DataNode[] = visible.map((n) => {
    const owner = idx.fileOf.get(n.id);
    const file = owner ? idx.nodes.get(owner) : undefined;
    const props = n.properties;
    return {
      id: n.id,
      l: n.label,
      n: nodeName({ id: n.id, label: n.label, props } as IndexNode),
      f: file ? String(file.props.relativePath ?? "") : null,
      line: typeof props.line === "number" ? props.line : null,
      g: "", d: 0, x: 0, y: 0,
    };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const edges = selection.edges
    .filter((e) => ids.has(e.from) && ids.has(e.to))
    .map((e) => ({ s: e.from, t: e.to, k: e.type, c: kindOf(e.type), w: typeof e.properties.count === "number" ? e.properties.count : 1 }));

  // The same picture as the app's graph screen: folders are clusters, seeded apart; the viewer relaxes each one.
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.s, (degree.get(e.s) ?? 0) + 1);
    degree.set(e.t, (degree.get(e.t) ?? 0) + 1);
  }
  const clusterNames = clusterOf(nodes.map((n) => n.f));
  const counts = new Map<string, number>();
  nodes.forEach((n, i) => { n.g = clusterNames[i]!; n.d = degree.get(n.id) ?? 0; counts.set(n.g, (counts.get(n.g) ?? 0) + 1); });
  const { positions, centers } = seedLayout(nodes.map((n) => ({ id: n.id, group: n.g, degree: n.d })), [...counts].map(([name, count]) => ({ name, count })));
  for (const n of nodes) { const at = positions.get(n.id)!; n.x = Math.round(at.x * 10) / 10; n.y = Math.round(at.y * 10) / 10; }
  const clusters = [...centers].map(([name, c]) => ({ name: name === "(other)" ? "shared" : name, key: name, x: c.x, y: c.y, r: c.radius, n: counts.get(name) ?? 0 }));
  const details: Record<string, Array<[string, string, number | null]>> = {};
  let notice = "";
  if (useAggregated) {
    for (const n of nodes) {
      details[n.id] = (idx.declared.get(n.id) ?? [])
        .map((id) => idx.nodes.get(id)!)
        .filter((d) => !HIDDEN_LABELS.has(d.label))
        .map((d): [string, string, number | null] => [d.label, nodeName(d), typeof d.props.line === "number" ? d.props.line : null]);
    }
    notice = `The graph has more than ${HTML_NODE_CAP} nodes. This file shows the file level with the declarations of each file as detail, not every symbol.`;
  }
  const title = `Concentrate graph: ${idx.rootPath}`;
  const data = JSON.stringify({ title, notice, nodes, edges, clusters, colors: LABEL_COLORS, edgeColors: EDGE_COLORS, details: useAggregated ? details : undefined })
    .replace(/</g, "\\u003c").replace(new RegExp("\\u2028", "g"), "\\u2028").replace(new RegExp("\\u2029", "g"), "\\u2029");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeXml(title)}</title><style>${VIEWER_CSS}</style></head>
<body>
<header><strong>Concentrate</strong><span class="tag">${escapeXml(idx.rootPath)}</span><input id="q" type="text" placeholder="Search"><span class="tag">${nodes.length} nodes, ${edges.length} edges</span>${notice ? `<span id="notice">${escapeXml(notice)}</span>` : ""}</header>
<main><canvas id="c"></canvas><div id="legend"></div></main>
<aside id="detail"><p class="tag">Select a node. Drag to pan, scroll to zoom.</p></aside>
<script id="graph-data" type="application/json">${data}</script>
<script>${VIEWER_JS}</script>
</body></html>
`;
}

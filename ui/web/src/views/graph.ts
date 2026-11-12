import { currentProject, exportUrl, graphPreset, runQuery, graphNeighbors, graphNode, graphOverview, graphSearch, graphSource, graphSummary, type Overview, type ViewNode } from "../api.js";
import { GraphCanvas, MAX_DRAWN_NODES } from "../graph/canvas.js";
import { color, EDGE_KIND_COLORS, EDGE_KIND_LABELS } from "../graph/colors.js";

const esc = (s: unknown) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const KINDS = Object.keys(EDGE_KIND_LABELS);
// Structure is shown when a node is expanded; the overview never draws it.
const OVERVIEW_DEFAULT = KINDS.filter((k) => k !== "defines");

export function mountGraphView(root: HTMLElement, onBack: () => void): void {
  root.innerHTML = `
    <div class="gv">
      <header class="gv-bar">
        <button id="back">← Scan</button>
        <select id="level"><option value="package">Packages</option><option value="directory" selected>Directories</option><option value="file">Files</option></select>
        <button id="up" title="Up one directory">↑</button>
        <span class="tag" id="crumb"></span>
        <div class="search"><input type="text" id="q" placeholder="Search symbols and files" /><ul id="hits" class="hits" hidden></ul></div>
        <span class="tag" id="stats"></span>
        <button id="query">Query</button><button id="export">Export…</button><button id="theme" title="Theme">◐</button>
      </header>
      <aside class="gv-side">
        <h2>Questions</h2>
        <div id="presets" class="presets">
          <button data-preset="imports">Import graph</button>
          <button data-preset="call-graph" id="callPreset" disabled title="Select a symbol first">Calls around the selected symbol</button>
          <button data-preset="routes-handlers-tables">Routes → handlers → tables</button>
          <button data-preset="requests-routes">Frontend requests → routes</button>
          <button data-preset="component-tree">Component tree</button>
          <button data-preset="import-cycles">Import cycles</button>
        </div>
        <h2>Relationships</h2><div id="kinds"></div>
        <h2>Node labels</h2><div id="legend"></div>
        <p class="tag">Click selects, double-click expands. Directories drill down; files and symbols show their neighbours.</p>
      </aside>
      <div class="gv-canvas" id="canvas"></div>
      <aside class="gv-detail" id="detail"><p class="tag">Select a node.</p></aside>
      <div class="gv-msg" id="msg" hidden></div>
      <section class="gv-query" id="queryPanel" hidden>
        <div class="row"><strong>Cypher (read-only)</strong><button id="runQuery" class="primary">Run</button><button id="closeQuery">Close</button><span class="tag" id="queryInfo"></span></div>
        <textarea id="cypher" rows="3" spellcheck="false">MATCH (r:Route) RETURN r.method AS method, r.fullPath AS path, id(r) AS id LIMIT 25</textarea>
        <div class="results" id="queryResults"></div>
      </section>
      <dialog id="exportDialog">
        <h2>Export</h2>
        <div class="row"><label>Format <select id="fmt">
          <option value="json">JSON (one file)</option><option value="jsonl">JSONL (zip: nodes, relationships, summary)</option>
          <option value="graphml">GraphML (Gephi, yEd)</option><option value="dot">DOT (Graphviz)</option><option value="html">HTML (self-contained viewer)</option></select></label></div>
        <div class="row" style="margin-top:8px"><label>Scope <select id="scope">
          <option value="graph">Whole graph</option><option value="view">Current view</option></select></label></div>
        <p class="tag" id="exportNote"></p>
        <div class="row"><a id="download" class="btn primary" href="#" download>Download</a><button id="exportClose">Close</button></div>
      </dialog>
    </div>`;
  const $ = <T extends HTMLElement>(id: string) => root.querySelector<T>(`#${id}`)!;
  const canvas = new GraphCanvas($("canvas"));
  const enabled = new Set(OVERVIEW_DEFAULT);
  let prefix = "";
  let mode: "overview" | "focus" = "overview";
  const labelsOnCanvas = new Map<string, string>();

  const message = (text?: string) => { $("msg").hidden = !text; $("msg").textContent = text ?? ""; };
  const kinds = () => [...enabled];
  const updateStats = () => { $("stats").textContent = `${canvas.graph.order} nodes · ${canvas.graph.size} edges`; };
  const renderLegend = () => {
    const labels = [...new Set(labelsOnCanvas.values())].sort();
    $("legend").innerHTML = labels.map((l) => `<div><span class="dot" style="background:${color(l)}"></span>${esc(l)}</div>`).join("");
  };

  $("kinds").innerHTML = KINDS.map((k) => `<label><input type="checkbox" data-kind="${k}" ${enabled.has(k) ? "checked" : ""}><span class="dot" style="background:${EDGE_KIND_COLORS[k]}"></span>${esc(EDGE_KIND_LABELS[k])}</label>`).join("");
  $("kinds").addEventListener("change", (e) => {
    const input = e.target as HTMLInputElement;
    if (input.checked) enabled.add(input.dataset.kind!); else enabled.delete(input.dataset.kind!);
    if (mode === "overview") void loadOverview(); else canvas.setHiddenKinds(new Set(KINDS.filter((k) => !enabled.has(k))));
  });

  async function loadOverview(): Promise<void> {
    mode = "overview";
    const level = $<HTMLSelectElement>("level").value;
    $("crumb").textContent = prefix ? `/${prefix}` : "";
    try {
      message("Loading…");
      const data: Overview = await graphOverview(level, prefix, kinds().filter((k) => k !== "defines"));
      prefix = data.prefix;
      $("crumb").textContent = prefix ? `/${prefix}` : "";
      labelsOnCanvas.clear();
      for (const n of data.nodes) labelsOnCanvas.set(n.id, n.label);
      const max = Math.max(1, ...data.nodes.map((n) => n.files));
      const drawn = canvas.set(
        data.nodes.map((n) => ({ id: n.id, label: n.label, name: n.name, size: n.label === "File" ? 3 + Math.min(10, 1.2 * Math.sqrt(n.degree)) : 4 + 14 * Math.sqrt(n.files / max) })),
        data.edges.map((e) => ({ from: e.from, to: e.to, kind: dominantKind(e.byKind), weight: e.count })),
      );
      message(!drawn ? `${data.nodes.length} nodes is above the ${MAX_DRAWN_NODES} node cap: pick a package or directory level.` : data.truncated ? `Showing the ${data.nodes.length} most connected nodes; use directories to drill down.` : data.isolatedHidden > 0 ? `${data.isolatedHidden} files without relationships are hidden; drill into a directory to see them.` : undefined);
      renderLegend();
      updateStats();
    } catch (error) { message((error as Error).message); }
  }

  async function expand(id: string): Promise<void> {
    if (id.startsWith("dir:")) { prefix = id.slice(4); $<HTMLSelectElement>("level").value = "directory"; return loadOverview(); }
    if (id.startsWith("package:")) { prefix = ""; $<HTMLSelectElement>("level").value = "directory"; return loadOverview(); }
    try {
      const data = await graphNeighbors(id, [...enabled, "defines"], 1);
      for (const n of data.nodes) labelsOnCanvas.set(n.id, n.label);
      if (!canvas.add(data.nodes.map(toCanvasNode), data.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })))) message(`Above the ${MAX_DRAWN_NODES} node cap; filter or go back to the overview.`);
      else message(data.truncated ? "Neighbours capped; filter the relationships to see the rest." : undefined);
      canvas.setHiddenKinds(new Set(KINDS.filter((k) => !enabled.has(k) && k !== "defines")));
      renderLegend(); updateStats();
    } catch (error) { message((error as Error).message); }
  }

  const toCanvasNode = (n: ViewNode) => ({ id: n.id, label: n.label, name: n.name, size: n.label === "File" ? 7 : 5 });

  async function showDetail(id: string | null): Promise<void> {
    if (!id) { $("detail").innerHTML = `<p class="tag">Select a node.</p>`; return; }
    if (id.startsWith("dir:") || id.startsWith("package:")) {
      $("detail").innerHTML = `<h2>${esc(canvas.graph.getNodeAttribute(id, "label"))}</h2><p class="tag">${esc(canvas.graph.getNodeAttribute(id, "nodeLabel"))} — double-click to drill down.</p>`;
      return;
    }
    $("detail").innerHTML = `<p class="tag">Loading…</p>`;
    try {
      const [detail, source] = await Promise.all([graphNode(id), graphSource(id).catch(() => null)]);
      const props = Object.entries(detail.properties).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === "string" && v.length > 120 ? `${v.slice(0, 120)}…` : v)}</td></tr>`).join("");
      const rels = (title: string, groups: NodeDetailGroups) => Object.keys(groups).length === 0 ? "" :
        `<h3>${title}</h3>${Object.entries(groups).map(([type, items]) => `<div class="tag">${esc(type)}</div><ul class="rels">${items.map((i) => `<li data-id="${esc(i.id)}">${esc(i.name)} <span class="tag">${esc(i.label)}</span></li>`).join("")}</ul>`).join("")}`;
      $("detail").innerHTML = `<h2>${esc(detail.name)}</h2>
        <div class="tag"><span class="dot" style="background:${color(detail.label)}"></span>${esc(detail.label)}${detail.file ? ` · ${esc(detail.file)}${detail.line ? `:${detail.line}` : ""}` : ""}</div>
        ${source?.source ? `<pre class="src">${esc(source.source)}${source.truncated ? "\n…" : ""}</pre>` : ""}
        ${rels("Outgoing", detail.outgoing)}${rels("Incoming", detail.incoming)}
        <h3>Properties</h3><table class="props">${props}</table>`;
    } catch (error) { $("detail").innerHTML = `<p class="bad">${esc((error as Error).message)}</p>`; }
  }
  type NodeDetailGroups = Record<string, Array<{ id: string; label: string; name: string }>>;

  $("detail").addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("li[data-id]") as HTMLElement | null;
    if (li) void focusNode(li.dataset.id!);
  });

  async function focusNode(id: string): Promise<void> {
    mode = "focus";
    focusId = id;
    try {
      const data = await graphNeighbors(id, [...enabled, "defines"], 1);
      labelsOnCanvas.clear();
      for (const n of data.nodes) labelsOnCanvas.set(n.id, n.label);
      canvas.set(data.nodes.map(toCanvasNode), data.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })));
      canvas.setHiddenKinds(new Set(KINDS.filter((k) => !enabled.has(k) && k !== "defines")));
      message(data.truncated ? "Neighbours capped; filter the relationships to see the rest." : undefined);
      $("crumb").textContent = "focus — change the level to return to the overview";
      renderLegend(); updateStats();
      canvas.focus(id);
      void showDetail(id);
    } catch (error) { message((error as Error).message); }
  }

  let focusId: string | undefined;
  let selectedId: string | null = null;
  const callPreset = $<HTMLButtonElement>("callPreset");

  async function runPreset(name: string): Promise<void> {
    try {
      if (name === "imports") {
        enabled.clear(); enabled.add("imports");
        root.querySelectorAll<HTMLInputElement>("#kinds input").forEach((i) => { i.checked = i.dataset.kind === "imports"; });
        $<HTMLSelectElement>("level").value = "file"; prefix = "";
        return loadOverview();
      }
      if (name === "call-graph") {
        if (!selectedId || selectedId.startsWith("dir:") || selectedId.startsWith("package:")) return;
        mode = "focus"; focusId = selectedId;
        const data = await graphNeighbors(selectedId, ["calls"], 2);
        labelsOnCanvas.clear();
        for (const n of data.nodes) labelsOnCanvas.set(n.id, n.label);
        canvas.set(data.nodes.map(toCanvasNode), data.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind })));
        message(data.truncated ? "Capped; select a more specific symbol." : data.nodes.length < 2 ? "This symbol has no resolved calls." : undefined);
        $("crumb").textContent = "calls around the selected symbol (2 levels)";
        renderLegend(); updateStats(); canvas.focus(focusId);
        return;
      }
      message("Loading…");
      const data = await graphPreset(name);
      mode = "focus"; focusId = undefined;
      labelsOnCanvas.clear();
      for (const n of data.nodes) labelsOnCanvas.set(n.id, n.label);
      canvas.set(data.nodes.map(toCanvasNode), data.edges.map((e) => ({ from: e.from, to: e.to, kind: e.kind, highlight: e.highlight })));
      message(data.nodes.length === 0 ? `Nothing found. ${data.note}` : data.note);
      $("crumb").textContent = name;
      renderLegend(); updateStats();
    } catch (error) { message((error as Error).message); }
  }
  $("presets").addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest("button[data-preset]") as HTMLButtonElement | null;
    if (b && !b.disabled) void runPreset(b.dataset.preset!);
  });

  // Cypher panel
  $("query").addEventListener("click", () => { $("queryPanel").hidden = !$("queryPanel").hidden; });
  $("closeQuery").addEventListener("click", () => { $("queryPanel").hidden = true; });
  async function execute(): Promise<void> {
    const info = $("queryInfo"), results = $("queryResults");
    info.textContent = "Running…";
    try {
      const out = await runQuery($<HTMLTextAreaElement>("cypher").value);
      info.textContent = `${out.total} rows${out.truncated ? `, first ${out.rows.length} shown` : ""}`;
      const cell = (v: unknown) => v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
      results.innerHTML = out.rows.length === 0 ? `<p class="tag">No rows.</p>` :
        `<table class="props"><thead><tr>${out.columns.map((c) => `<th>${esc(c)}</th>`).join("")}</tr></thead><tbody>${out.rows.map((row) =>
          `<tr ${typeof row.id === "string" ? `data-id="${esc(row.id)}" class="link"` : ""}>${out.columns.map((c) => `<td>${esc(cell(row[c]))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
    } catch (error) {
      info.textContent = "";
      results.innerHTML = `<p class="bad">${esc((error as Error).message)}</p>`;
    }
  }
  $("runQuery").addEventListener("click", () => void execute());
  $("cypher").addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void execute(); });
  $("queryResults").addEventListener("click", (e) => {
    const tr = (e.target as HTMLElement).closest("tr[data-id]") as HTMLElement | null;
    if (tr) void focusNode(tr.dataset.id!);
  });

  // Theme: follow the system until the toggle is used.
  const applyTheme = (theme: string | null) => {
    if (theme) document.documentElement.dataset.theme = theme; else delete document.documentElement.dataset.theme;
    const dark = theme ? theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    canvas.setTheme(dark);
  };
  let stored: string | null = null;
  try { stored = localStorage.getItem("concentrate-theme"); } catch { /* storage unavailable */ }
  applyTheme(stored);
  $("theme").addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme ? document.documentElement.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
    const next = dark ? "light" : "dark";
    try { localStorage.setItem("concentrate-theme", next); } catch { /* storage unavailable */ }
    applyTheme(next);
  });

  const updateExport = () => {
    const scope = $<HTMLSelectElement>("scope").value as "graph" | "view";
    const format = $<HTMLSelectElement>("fmt").value;
    $<HTMLAnchorElement>("download").href = exportUrl({ format, scope, types: kinds(), prefix, focus: mode === "focus" ? focusId : undefined });
    $("exportNote").textContent = scope === "view"
      ? (mode === "focus" ? "The focused node, its neighbours and the relationships shown." : `The files${prefix ? ` under /${prefix}` : ""} and the relationships between them, for the selected kinds.`)
      : "Every node and relationship of the stored graph. DOT and HTML use the file level above 5,000 nodes.";
  };
  $("export").addEventListener("click", () => { updateExport(); $<HTMLDialogElement>("exportDialog").showModal(); });
  $("exportClose").addEventListener("click", () => $<HTMLDialogElement>("exportDialog").close());
  $("fmt").addEventListener("change", updateExport);
  $("scope").addEventListener("change", updateExport);
  canvas.onSelect = (id) => { selectedId = id; callPreset.disabled = !id || id.startsWith("dir:") || id.startsWith("package:"); void showDetail(id); };
  canvas.onExpand = (id) => void expand(id);
  $("level").addEventListener("change", () => { prefix = ""; void loadOverview(); });
  $("up").addEventListener("click", () => { prefix = prefix.includes("/") ? prefix.slice(0, prefix.lastIndexOf("/")) : ""; void loadOverview(); });
  $("back").addEventListener("click", () => { canvas.destroy(); onBack(); });

  let timer: number | undefined;
  $("q").addEventListener("input", () => {
    window.clearTimeout(timer);
    const q = $<HTMLInputElement>("q").value.trim();
    if (!q) { $("hits").hidden = true; return; }
    timer = window.setTimeout(async () => {
      try {
        const { results } = await graphSearch(q);
        $("hits").innerHTML = results.slice(0, 12).map((r) => `<li data-id="${esc(r.id)}"><span class="dot" style="background:${color(r.label)}"></span>${esc(r.name)} <span class="tag">${esc(r.label)}${r.file ? ` · ${esc(r.file)}` : ""}</span></li>`).join("") || `<li class="tag">No match</li>`;
        $("hits").hidden = false;
      } catch (error) { message((error as Error).message); }
    }, 200);
  });
  $("hits").addEventListener("click", (e) => {
    const li = (e.target as HTMLElement).closest("li[data-id]") as HTMLElement | null;
    if (!li) return;
    $("hits").hidden = true;
    void focusNode(li.dataset.id!);
  });

  void graphSummary().catch(() => undefined);
  void loadOverview();
  void currentProject;
}

function dominantKind(byKind: Record<string, number>): string {
  return Object.entries(byKind).sort((a, b) => b[1] - a[1])[0]?.[0] ?? "other";
}

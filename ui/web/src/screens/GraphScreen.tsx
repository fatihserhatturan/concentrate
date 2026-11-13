import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { graphFocus, graphOverview, graphPathBetween, graphPreset, type OverviewNode, type ViewEdge, type ViewNode } from "../api.js";
import { Icon } from "../components/icons.js";
import { SummaryList } from "../components/Inspector.js";
import { KindGlyph } from "../components/KindGlyph.js";
import { QueryPanel } from "../components/QueryPanel.js";
import { SearchBox } from "../components/SearchBox.js";
import { ExportDialog } from "../components/ExportDialog.js";
import { ErrorState, Loading } from "../components/State.js";
import { CATEGORIES, categoryOfKind, kindsOf, parseEnabled, type CategoryId } from "../graph/categories.js";
import { LayeredGraph } from "../graph/LayeredGraph.js";
import { SigmaGraph, type SigmaEdge, type SigmaNode } from "../graph/SigmaGraph.js";
import { useRegisterCommands, type Command } from "../lib/commands.js";
import { number } from "../lib/format.js";
import { navigate, type Route } from "../lib/router.js";
import { useLoad } from "../lib/useLoad.js";

const DEFAULT_LIMIT = 40;
const LAYERED_MAX = 400;
const PRESETS: Array<{ id: string; title: string; text: string }> = [
  { id: "routes-handlers-tables", title: "Routes → handlers → tables", text: "Which routes exist, who handles them and what they read and write" },
  { id: "requests-routes", title: "Frontend requests → routes", text: "Which frontend calls reach which backend routes" },
  { id: "component-tree", title: "Component tree", text: "Pages and components, and which renders which" },
  { id: "import-cycles", title: "Import cycles", text: "Files that import each other in a loop" },
];

type Loaded =
  | { mode: "overview"; level: string; data: Awaited<ReturnType<typeof graphOverview>> }
  | { mode: "focus"; data: Awaited<ReturnType<typeof graphFocus>> }
  | { mode: "path"; data: Awaited<ReturnType<typeof graphPathBetween>> }
  | { mode: "preset"; data: Awaited<ReturnType<typeof graphPreset>> };

type GraphFields = Pick<Route, "focus" | "to" | "level" | "prefix" | "depth" | "show" | "noise" | "preset">;

function dominantCategory(byKind: Record<string, number>): CategoryId {
  const top = Object.entries(byKind).sort((a, b) => b[1] - a[1])[0];
  return categoryOfKind(top?.[0] ?? "other").id;
}

function Menu(props: { label: string; children: (close: () => void) => ComponentChildren }) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => { if (!(event.target as HTMLElement).closest(".menu")) setOpen(false); };
    const esc = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", esc);
    return () => { window.removeEventListener("pointerdown", close); window.removeEventListener("keydown", esc); };
  }, [open]);
  return (
    <div class="menu">
      <button class="btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>{props.label} ▾</button>
      {open && <div class="menu-list" role="menu">{props.children(() => setOpen(false))}</div>}
    </div>
  );
}

export function GraphScreen(props: { project: string; route: Route; setSummary: (summary: ComponentChildren) => void }) {
  const { route } = props;
  const enabled = parseEnabled(route.show);
  const kinds = kindsOf(enabled);
  const level = route.level ?? "directory";
  const prefix = route.prefix ?? "";
  const depth = route.depth && route.depth > 1 ? Math.min(3, route.depth) : 1;
  const mode: Loaded["mode"] = route.preset ? "preset" : route.focus && route.to ? "path" : route.focus ? "focus" : "overview";

  const [limit, setLimit] = useState(DEFAULT_LIMIT);
  const [tracing, setTracing] = useState(false);
  // Docked beside the graph: on a narrow window it would leave the graph a sliver, so it starts closed there.
  const [legendOpen, setLegendOpen] = useState(() => window.innerWidth >= 1200);
  const [queryOpen, setQueryOpen] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [pseudo, setPseudo] = useState<string | null>(null);

  const current: GraphFields = { focus: route.focus, to: route.to, level: route.level, prefix: route.prefix, depth: route.depth, show: route.show, noise: route.noise, preset: route.preset };
  const go = (patch: Partial<GraphFields>, replace = false) => navigate({ project: props.project, view: "graph", ...current, ...patch }, { replace });

  useEffect(() => { setLimit(DEFAULT_LIMIT); setTracing(false); setPseudo(null); }, [route.focus, route.preset, route.level, route.prefix]);

  // Commands for the palette, and Esc: step back out of the most recent thing, one at a time.
  const latest = useRef({ go, route, mode, queryOpen, tracing, pseudo });
  latest.current = { go, route, mode, queryOpen, tracing, pseudo };
  const commands = useMemo<Command[]>(() => {
    const act = () => latest.current;
    const overviewOnly = mode === "overview" ? undefined : "Only in the folder overview";
    const focusOnly = mode === "focus" ? undefined : "Focus a node first";
    return [
      { id: "graph.fit", title: "Fit the graph in view", group: "Graph", shortcut: "F", keywords: "zoom reset center", run: () => window.dispatchEvent(new CustomEvent("concentrate:fit")) },
      { id: "graph.back", title: "Back to the folder overview", group: "Graph", disabledReason: mode === "overview" ? "Already showing the overview" : undefined, run: () => act().go({ focus: undefined, to: undefined, preset: undefined }) },
      { id: "graph.trace", title: "Trace a path from the focused node", group: "Graph", keywords: "route between connect", disabledReason: focusOnly, run: () => setTracing(true) },
      { id: "graph.query", title: queryOpen ? "Close the Cypher query panel" : "Open the Cypher query panel", group: "Graph", keywords: "cypher sql", run: () => setQueryOpen((open) => !open) },
      { id: "graph.export", title: "Export the graph…", group: "Graph", keywords: "download json graphml dot html jsonl", run: () => setExportOpen(true) },
      { id: "graph.legend", title: legendOpen ? "Hide the legend" : "Show the legend", group: "Graph", keywords: "filters relationships", run: () => setLegendOpen((open) => !open) },
      ...([1, 2, 3] as const).map((n): Command => ({ id: `graph.depth.${n}`, title: `Show ${n} ${n === 1 ? "step" : "steps"} each way`, group: "Graph", keywords: "depth neighbours", disabledReason: focusOnly, run: () => act().go({ depth: n }, true) })),
      ...([["package", "packages"], ["directory", "folders"], ["file", "files"]] as const).map(([id, label]): Command => ({ id: `graph.level.${id}`, title: `Overview by ${label}`, group: "Graph", keywords: "level", disabledReason: overviewOnly, run: () => act().go({ level: id, prefix: undefined }) })),
      { id: "graph.noise", title: route.noise ? "Hide dot-folders and build output" : "Show dot-folders and build output", group: "Graph", keywords: "noise hidden", disabledReason: overviewOnly, run: () => act().go({ noise: act().route.noise ? undefined : true }, true) },
      { id: "q.imports", title: "Question: Import graph", group: "Questions", keywords: "files import", run: () => act().go({ preset: undefined, focus: undefined, to: undefined, level: "file", prefix: undefined, show: "imports" }) },
      { id: "q.calls", title: "Question: Calls around the focused node", group: "Questions", keywords: "callers callees", disabledReason: focusOnly, run: () => act().go({ show: "calls", depth: 2, to: undefined, preset: undefined }) },
      ...PRESETS.map((p): Command => ({ id: `q.${p.id}`, title: `Question: ${p.title}`, group: "Questions", keywords: p.text, run: () => act().go({ preset: p.id, focus: undefined, to: undefined }) })),
    ];
  }, [mode, queryOpen, legendOpen, route.noise]);
  useRegisterCommands("graph", commands);

  useEffect(() => {
    const onEscape = () => {
      const { go: navigateTo, route: r, queryOpen: q, tracing: t, pseudo: p } = latest.current;
      if (q) setQueryOpen(false);
      else if (t) setTracing(false);
      else if (r.to) navigateTo({ to: undefined });
      else if (r.preset) navigateTo({ preset: undefined });
      else if (r.focus) navigateTo({ focus: undefined });
      else if (p) setPseudo(null);
    };
    window.addEventListener("concentrate:escape", onEscape);
    return () => window.removeEventListener("concentrate:escape", onEscape);
  }, []);

  const key = JSON.stringify([mode, level, prefix, route.focus, route.to, depth, kinds, route.preset, limit]);
  const [state, retry] = useLoad<Loaded>(async () => {
    if (mode === "preset") return { mode, data: await graphPreset(route.preset!) };
    if (mode === "path") return { mode, data: await graphPathBetween(route.focus!, route.to!, kinds) };
    if (mode === "focus") return { mode, data: await graphFocus(route.focus!, kinds, depth, limit) };
    return { mode: "overview", level, data: await graphOverview(level, prefix, kinds.filter((k) => k !== "defines")) };
  }, [key, props.project]);

  const loaded = state.status === "ready" ? state.data : null;

  // What the overview draws: noise folders and nodes without relationships are kept out of the picture, with a count.
  const overview = useMemo(() => {
    if (loaded?.mode !== "overview") return null;
    const { nodes, edges } = loaded.data;
    const showNoise = route.noise === true;
    const noise = nodes.filter((n) => n.noise);
    const visible = nodes.filter((n) => (showNoise || !n.noise) && n.degree > 0);
    const ids = new Set(visible.map((n) => n.id));
    const isolated = nodes.filter((n) => n.degree === 0 && (showNoise || !n.noise));
    const max = Math.max(1, ...visible.map((n) => n.files));
    const sigmaNodes: SigmaNode[] = visible.map((n) => ({
      id: n.id, label: n.label, name: n.name, noise: n.noise,
      size: n.label === "File" ? 3 + Math.min(10, 1.2 * Math.sqrt(n.degree)) : 5 + 14 * Math.sqrt(n.files / max),
    }));
    const sigmaEdges: SigmaEdge[] = edges.filter((e) => ids.has(e.from) && ids.has(e.to)).map((e) => ({ from: e.from, to: e.to, category: dominantCategory(e.byKind), weight: e.count }));
    return { nodes: visible, edges: edges.filter((e) => ids.has(e.from) && ids.has(e.to)), sigmaNodes, sigmaEdges, noise, isolated };
  }, [loaded, route.noise]);

  const presetBig = loaded?.mode === "preset" && loaded.data.nodes.length > LAYERED_MAX;
  // Computed once per result: a new array on every render would lay the graph out again.
  const presetSigma = useMemo(() => {
    if (loaded?.mode !== "preset" || !presetBig) return null;
    return {
      nodes: loaded.data.nodes.map((n): SigmaNode => ({ id: n.id, label: n.label, name: n.name, size: 4 })),
      edges: loaded.data.edges.map((e): SigmaEdge => ({ from: e.from, to: e.to, category: categoryOfKind(e.kind).id, weight: 1 })),
    };
  }, [loaded, presetBig]);

  // Edges of whatever is drawn, counted by category for the legend.
  const categoryCounts = useMemo(() => {
    const counts = new Map<CategoryId, number>();
    if (loaded?.mode === "overview") for (const e of overview?.edges ?? []) for (const [kind, n] of Object.entries(e.byKind)) counts.set(categoryOfKind(kind).id, (counts.get(categoryOfKind(kind).id) ?? 0) + n);
    else if (loaded) for (const e of loaded.data.edges as ViewEdge[]) counts.set(categoryOfKind(e.kind).id, (counts.get(categoryOfKind(e.kind).id) ?? 0) + 1);
    return counts;
  }, [loaded, overview]);

  const drawnNodes: Array<{ label: string }> = loaded?.mode === "overview" ? overview?.nodes ?? [] : loaded?.data.nodes ?? [];
  const kindsShown = [...new Set(drawnNodes.map((n) => n.label))].sort();

  // The inspector shows the selected node; with none, the summary of the view or of a selected folder.
  useEffect(() => {
    if (loaded?.mode !== "overview" || !overview) return;
    const node = pseudo ? overview.nodes.find((n) => n.id === pseudo) : undefined;
    if (node) {
      const links = overview.edges.filter((e) => e.from === node.id || e.to === node.id);
      const names = new Map(overview.nodes.map((n) => [n.id, n.name]));
      props.setSummary(
        <div class="stack">
          <div><span class="badge">{node.label}</span><h3 class="insp-title">{node.name}</h3></div>
          <div class="kv"><div><span class="v">{number(node.files)}</span><span class="k">files</span></div><div><span class="v">{number(node.degree)}</span><span class="k">links</span></div></div>
          {node.id.startsWith("dir:") && <div class="row"><button class="btn btn-primary" onClick={() => go({ prefix: node.id.slice(4), level: "directory", focus: undefined })}>Open this folder</button></div>}
          {links.length > 0 && (
            <section><h4 class="section-h">Linked folders</h4>
              <ul class="plain-list">{links.sort((a, b) => b.count - a.count).slice(0, 12).map((e) => {
                const other = e.from === node.id ? e.to : e.from;
                return <li><span class="small" title={names.get(other)}>{e.from === node.id ? "uses " : "used by "}{names.get(other) ?? other}</span><span class="muted small">{number(e.count)}</span></li>;
              })}</ul></section>
          )}
        </div>,
      );
      return;
    }
    const top = [...overview.nodes].sort((a, b) => b.files - a.files).slice(0, 12).map((n) => ({ label: n.name, count: n.files }));
    props.setSummary(<SummaryList title={prefix ? `/${prefix}` : "Project"} subtitle={`${loaded.level === "file" ? "Connected files" : "Biggest folders"}, by files`} groups={top} total={overview.nodes.reduce((n, x) => n + x.files, 0)} hint="Click a file to focus on it. Click a folder to look at it, double-click to open it." />);
  }, [loaded, overview, pseudo]);
  useEffect(() => {
    if (!loaded || loaded.mode === "overview") return;
    props.setSummary(<p class="muted small">Click a node in the graph to refocus on it.</p>);
  }, [loaded?.mode]);

  const centerName = loaded && loaded.mode !== "overview" ? (loaded.data.nodes as ViewNode[]).find((n) => n.id === (route.focus ?? ""))?.name : undefined;
  const toName = loaded?.mode === "path" ? loaded.data.nodes.find((n) => n.id === route.to)?.name : undefined;

  const toggleCategory = (id: CategoryId) => {
    const next = new Set(enabled);
    if (next.has(id)) next.delete(id); else next.add(id);
    go({ show: CATEGORIES.filter((c) => next.has(c.id)).map((c) => c.id).join(",") }, true);
  };

  const onActivate = (id: string, options: { trace: boolean }) => {
    if (options.trace && route.focus && id !== route.focus && !route.preset) { setTracing(false); go({ to: id }); return; }
    go({ focus: id, to: undefined, preset: undefined });
  };

  const crumbs = (() => {
    const home = <button onClick={() => go({ focus: undefined, to: undefined, preset: undefined, prefix: undefined })}>Overview</button>;
    if (mode === "preset") return <>{home}<span class="sep">/</span><strong>{PRESETS.find((p) => p.id === route.preset)?.title ?? route.preset}</strong></>;
    if (mode === "path") return <>{home}<span class="sep">/</span><button onClick={() => go({ to: undefined })}>{centerName ?? "…"}</button><span class="sep">to</span><strong>{toName ?? "…"}</strong></>;
    if (mode === "focus") return <>{home}<span class="sep">/</span><strong>{centerName ?? "…"}</strong></>;
    // The server goes down through folders that hold a single folder, so show where the picture really is.
    const segments = (loaded?.mode === "overview" ? loaded.data.prefix : prefix).split("/").filter(Boolean);
    return (
      <>
        {segments.length > 0 ? <button onClick={() => go({ prefix: undefined })}>{level === "package" ? "Packages" : "Project"}</button> : <strong>{level === "package" ? "Packages" : level === "file" ? "Files" : "Project"}</strong>}
        {segments.map((segment, i) => <><span class="sep">/</span>{i === segments.length - 1 ? <strong>{segment}</strong> : <button onClick={() => go({ prefix: segments.slice(0, i + 1).join("/") })}>{segment}</button>}</>)}
      </>
    );
  })();

  const drillNode = (id: string) => {
    if (id.startsWith("dir:")) go({ prefix: id.slice(4), level: "directory", focus: undefined });
    else if (id.startsWith("package:")) go({ level: "directory", prefix: undefined });
    else go({ focus: id });
  };

  const body = (() => {
    if (state.status === "loading") return <Loading label={mode === "focus" ? "Finding what surrounds it…" : "Reading the graph…"} />;
    if (state.status === "error") return <ErrorState message={state.message} onRetry={retry} />;
    const data = state.data;
    if (data.mode === "overview") {
      if (!overview || overview.nodes.length === 0) {
        return (
          <div class="graph-empty"><div class="card card-pad">
            <h3>Nothing related to show here</h3>
            <p class="muted small" style={{ margin: "var(--space-2) 0 var(--space-3)" }}>{[...enabled].length === 0 ? "No relationship category is switched on. Switch some on in the legend." : "No folder or file has relationships of the selected kinds. Try switching on more kinds, or open another folder."}</p>
            {prefix && <button class="btn" onClick={() => go({ prefix: undefined })}>Back to the project</button>}
          </div></div>
        );
      }
      return <SigmaGraph nodes={overview.sigmaNodes} edges={overview.sigmaEdges} selectedId={pseudo} onClick={(id) => (id.startsWith("dir:") || id.startsWith("package:") ? setPseudo(id) : go({ focus: id }))} onDoubleClick={drillNode} />;
    }
    if (data.mode === "focus") {
      const { incoming, outgoing } = data.data;
      const more = (side: { total: number; shown: number }, grow: boolean) => (side.total > side.shown && grow ? { more: side.total - side.shown, onMore: () => setLimit((l) => l * 3) } : undefined);
      return (
        <>
          <LayeredGraph
            nodes={data.data.nodes} edges={data.data.edges} centerId={data.data.center} fitKey={key} tracing={tracing} onActivate={onActivate}
            headers={{ left: `Used by · ${incoming.shown === incoming.total ? number(incoming.total) : `${number(incoming.shown)} of ${number(incoming.total)}`}`, right: `Uses · ${outgoing.shown === outgoing.total ? number(outgoing.total) : `${number(outgoing.shown)} of ${number(outgoing.total)}`}` }}
            stubs={{ in: more(incoming, true), out: more(outgoing, true) }}
          />
          {data.data.nodes.length === 1 && (
            <div class="graph-empty" style={{ pointerEvents: "none" }}><div class="card card-pad" style={{ pointerEvents: "auto" }}>
              <h3>No relationships of the selected kinds</h3>
              <p class="muted small" style={{ marginTop: "var(--space-2)" }}>Switch on more kinds in the legend{enabled.has("structure") ? "" : ", for example Structure to see what a file declares"}.</p>
            </div></div>
          )}
        </>
      );
    }
    if (data.mode === "path") {
      if (!data.data.found) {
        return (
          <div class="graph-empty"><div class="card card-pad">
            <h3>No path between them</h3>
            <p class="muted small" style={{ margin: "var(--space-2) 0 var(--space-3)" }}>With the relationship kinds switched on, nothing connects {centerName} to {toName}. Switch on more kinds, or pick another node.</p>
            <button class="btn" onClick={() => go({ to: undefined })}>Clear the path</button>
          </div></div>
        );
      }
      return (
        <>
          <LayeredGraph nodes={data.data.nodes} edges={data.data.edges} centerId={route.focus} pathIds={new Set(data.data.nodes.map((n) => n.id))} fitKey={key} onActivate={onActivate} />
          <div class="graph-note"><span>{data.data.edges.length} {data.data.edges.length === 1 ? "step" : "steps"}{data.data.directed ? ", following the relationships' direction" : ", some against their direction"}.</span><button class="btn" onClick={() => go({ to: undefined })}>Clear path</button></div>
        </>
      );
    }
    // preset
    if (data.data.nodes.length === 0) {
      return <div class="graph-empty"><div class="card card-pad"><h3>Nothing found</h3><p class="muted small" style={{ margin: "var(--space-2) 0 var(--space-3)" }}>{data.data.note}</p><button class="btn" onClick={() => go({ preset: undefined })}>Back to the overview</button></div></div>;
    }
    return (
      <>
        {presetBig && presetSigma ? (
          <SigmaGraph
            nodes={presetSigma.nodes}
            edges={presetSigma.edges}
            onClick={(id) => go({ focus: id, preset: undefined })} onDoubleClick={(id) => go({ focus: id, preset: undefined })}
          />
        ) : <LayeredGraph nodes={data.data.nodes} edges={data.data.edges} fitKey={key} onActivate={onActivate} />}
        <div class="graph-note"><span>{data.data.note}</span><button class="btn" onClick={() => go({ preset: undefined })}>Close</button></div>
      </>
    );
  })();

  const overviewNotes = loaded?.mode === "overview" && overview ? (
    loaded.data.truncated ? `Showing the ${number(loaded.data.nodes.length)} most connected nodes. Open a folder to see the rest.`
    : loaded.data.isolatedHidden > 0 ? `${number(loaded.data.isolatedHidden)} files without relationships are left out. Open a folder to see them.` : null
  ) : null;

  return (
    <div class="graph-screen">
      <div class="graph-bar">
        <nav class="graph-crumbs" aria-label="Graph location">{crumbs}</nav>
        <span class="spacer" />
        {mode === "overview" && (
          <div class="segmented" role="group" aria-label="Level">
            {([["package", "Packages"], ["directory", "Folders"], ["file", "Files"]] as const).map(([id, label]) => (
              <button aria-pressed={level === id} onClick={() => go({ level: id, prefix: undefined })}>{label}</button>
            ))}
          </div>
        )}
        {mode === "focus" && (
          <div class="segmented" role="group" aria-label="Steps each way">
            {[1, 2, 3].map((n) => <button aria-pressed={depth === n} title={`${n} ${n === 1 ? "step" : "steps"} each way`} onClick={() => go({ depth: n }, true)}>{n} {n === 1 ? "step" : "steps"}</button>)}
          </div>
        )}
        <button class="btn" aria-pressed={tracing} disabled={mode !== "focus"} title={mode !== "focus" ? "Focus a node first, then trace a path from it to another" : tracing ? "Click the node to trace to (Esc cancels)" : "Trace the path from this node to another"} onClick={() => setTracing(!tracing)} style={tracing ? { borderColor: "var(--accent)", color: "var(--accent)" } : undefined}>
          <Icon name="route" /> {tracing ? "Pick the target…" : "Trace path"}
        </button>
        <Menu label="Questions">{(close) => (
          <>
            <button onClick={() => { close(); go({ preset: undefined, focus: undefined, to: undefined, level: "file", prefix: undefined, show: "imports" }); }}>Import graph<small>Which files import which</small></button>
            <button disabled={!route.focus || mode === "path"} title={!route.focus ? "Focus a symbol first" : undefined} onClick={() => { close(); go({ show: "calls", depth: 2, to: undefined, preset: undefined }); }}>Calls around the focused node<small>{route.focus ? "Two steps of calls each way" : "Focus a symbol first to ask this"}</small></button>
            {PRESETS.map((p) => <button onClick={() => { close(); go({ preset: p.id, focus: undefined, to: undefined }); }}>{p.title}<small>{p.text}</small></button>)}
          </>
        )}</Menu>
        <SearchBox onPick={(id) => go({ focus: id, to: undefined, preset: undefined })} />
        <button class="btn" aria-pressed={queryOpen} onClick={() => setQueryOpen(!queryOpen)}>Query</button>
        <button class="btn" onClick={() => setExportOpen(true)}>Export…</button>
        <span class="muted small" data-testid="graph-stats" aria-live="polite">{loaded ? `${number(loaded.mode === "overview" ? overview?.nodes.length : loaded.data.nodes.length)} nodes` : ""}</span>
      </div>

      <div class="graph-body">
        {legendOpen && (
          <aside class="legend" aria-label="Legend and filters">
            <div class="row" style={{ justifyContent: "space-between", marginBottom: "var(--space-2)" }}><h4 style={{ margin: 0 }}>Relationships</h4><button class="btn btn-ghost btn-icon" style={{ height: 22, width: 22 }} onClick={() => setLegendOpen(false)} title="Hide the legend" aria-label="Hide the legend"><Icon name="x" /></button></div>
            {CATEGORIES.map((c) => (
              <label title={c.hint}>
                <input type="checkbox" checked={enabled.has(c.id)} onChange={() => toggleCategory(c.id)} />
                <span class="swatch" style={{ borderTopColor: `var(--cat-${c.id})`, borderTopStyle: c.dash ? "dashed" : "solid" }} />
                {c.label}<span class="count">{enabled.has(c.id) && categoryCounts.get(c.id) ? number(categoryCounts.get(c.id)) : ""}</span>
              </label>
            ))}
            {kindsShown.length > 0 && <><h4>Nodes</h4>{kindsShown.map((k) => <div class="kind"><KindGlyph label={k} /> {k}</div>)}</>}
            {mode === "overview" && overview && (overview.noise.length > 0 || overview.isolated.length > 0) && (
              <>
                <h4>Left out</h4>
                {overview.noise.length > 0 && <label><input type="checkbox" checked={route.noise === true} onChange={() => go({ noise: route.noise ? undefined : true }, true)} />Dot-folders and build output<span class="count">{overview.noise.length}</span></label>}
                {overview.isolated.length > 0 && (
                  <details><summary class="small muted" style={{ cursor: "pointer" }}>{overview.isolated.length} without relationships</summary>
                    <ul class="plain-list" style={{ maxHeight: 160, overflow: "auto", marginTop: "var(--space-1)" }}>{overview.isolated.slice(0, 80).map((n) => <li><button class="link-button" title={n.name} onClick={() => drillNode(n.id)}>{n.name}</button></li>)}</ul></details>
                )}
              </>
            )}
          </aside>
        )}
        <div class="graph-main">
          {body}
          {!legendOpen && <button class="btn legend-toggle" onClick={() => setLegendOpen(true)}>Legend</button>}
          {overviewNotes && <div class="graph-note"><span>{overviewNotes}</span></div>}
          {queryOpen && <QueryPanel onClose={() => setQueryOpen(false)} onPick={(id) => go({ focus: id, to: undefined, preset: undefined })} />}
        </div>
      </div>
      <ExportDialog open={exportOpen} onClose={() => setExportOpen(false)} types={kinds} prefix={prefix} focus={mode === "focus" ? route.focus : undefined} />
    </div>
  );
}

import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useState } from "preact/hooks";
import { graphCatalog, graphIssues, setProject, type EntityKind } from "./api.js";
import { CommandPalette } from "./components/CommandPalette.js";
import { ErrorBoundary } from "./components/ErrorBoundary.js";
import { HelpSheet } from "./components/HelpSheet.js";
import { InspectorPanel } from "./components/Inspector.js";
import { NoGraph } from "./components/State.js";
import { Shell, type NavItem } from "./components/Shell.js";
import { useRegisterCommands, type Command } from "./lib/commands.js";
import { baseName } from "./lib/format.js";
import { useTheme } from "./lib/theme.js";
import { DEFAULT_VIEW, navigate, useRoute, type Route } from "./lib/router.js";
import { useLoad } from "./lib/useLoad.js";
import { ENTITY_INFO, EntityView } from "./screens/EntityView.js";
import { Issues } from "./screens/Issues.js";
import { GraphScreen } from "./screens/GraphScreen.js";
import { Overview } from "./screens/Overview.js";
import { Start } from "./screens/Start.js";

const ENTITY_VIEWS: Array<{ id: EntityKind; icon: NavItem["icon"] }> = [
  { id: "files", icon: "file" }, { id: "routes", icon: "route" }, { id: "tables", icon: "table" },
  { id: "components", icon: "component" }, { id: "env", icon: "env" }, { id: "entrypoints", icon: "entry" },
];
const isEntity = (view: string): view is EntityKind => ENTITY_VIEWS.some((v) => v.id === view);

function ProjectScreen({ project, view, route }: { project: string; view: string; route: Route }) {
  const focus = route.focus;
  setProject(project);
  const [catalog] = useLoad(graphCatalog, [project]);
  const [issues] = useLoad(graphIssues, [project]);
  const [summary, setSummaryState] = useState<{ view: string; node: ComponentChildren } | null>(null);
  const setSummary = (node: ComponentChildren) => setSummaryState({ view, node });

  // A view with nothing to show is left out of the navigation.
  const counts = catalog.status === "ready" ? catalog.data.views : null;
  const issueCount = issues.status === "ready" ? issues.data.cycles.length + issues.data.unused.length + issues.data.deadFunctions.length : null;
  const nav: NavItem[] = [
    { id: "overview", label: "Overview", icon: "overview", group: "Explore" },
    ...ENTITY_VIEWS.filter((v) => counts === null || counts[v.id] > 0 || v.id === view).map((v) => ({ id: v.id, label: ENTITY_INFO[v.id].title, icon: v.icon, count: counts?.[v.id], group: "Browse" })),
    ...(issueCount === null || issueCount > 0 || view === "issues" ? [{ id: "issues", label: "Issues", icon: "issue" as const, count: issueCount ?? undefined, group: "Analyse" }] : []),
    { id: "graph", label: "Graph", icon: "graph", group: "Analyse" },
  ];
  const active = nav.find((item) => item.id === view) ?? nav[0]!;
  const select = (id: string | null) => navigate({ project, view: active.id, focus: id ?? undefined }, { replace: true });
  // In the graph a click refocuses and keeps the filters; elsewhere it selects.
  const open = (id: string) => (view === "graph" ? navigate({ ...route, view: "graph", focus: id, to: undefined, preset: undefined }) : navigate({ project, view: active.id, focus: id }));
  const showInGraph = (id: string) => navigate({ project, view: "graph", focus: id });
  const onGraph = active.id === "graph";
  const focusInGraph = (id: string) => (view === "graph" ? navigate({ ...route, view: "graph", focus: id, to: undefined, preset: undefined }) : navigate({ project, view: "graph", focus: id }));
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [, toggleTheme] = useTheme();
  const noGraph = catalog.status === "error" && /scan the project first/.test(catalog.message);

  const commands = useMemo<Command[]>(() => [
    ...nav.map((item): Command => ({ id: `go.${item.id}`, title: `Go to ${item.label}`, group: "Go to", keywords: `open show view ${item.id}`, run: () => navigate({ project, view: item.id }) })),
    { id: "project.rescan", title: "Rescan this project", group: "Project", keywords: "scan refresh update", run: () => navigate({ project: null, view: DEFAULT_VIEW, scan: project }) },
    { id: "project.switch", title: "Switch project", group: "Project", keywords: "open choose start", run: () => navigate({ project: null, view: DEFAULT_VIEW }) },
    { id: "project.clear", title: "Clear the selection", group: "Project", shortcut: "Esc", disabledReason: focus ? undefined : "Nothing is selected", run: () => (onGraph ? navigate({ ...route, focus: undefined, to: undefined }) : select(null)) },
    { id: "theme.toggle", title: "Switch between light and dark theme", group: "Project", keywords: "appearance mode", run: toggleTheme },
    { id: "help.shortcuts", title: "Show keyboard shortcuts", group: "Help", shortcut: "?", run: () => setHelpOpen(true) },
  ], [project, view, focus, onGraph, catalog, issues]);
  useRegisterCommands("app", commands);

  // Shortcuts. Typing in a field never triggers them; Cmd/Ctrl+K works everywhere.
  useEffect(() => {
    const typing = (target: EventTarget | null) => target instanceof HTMLElement && (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setHelpOpen(false); setPaletteOpen((open) => !open); return; }
      if (paletteOpen || helpOpen || event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      if (event.key === "?") { event.preventDefault(); setHelpOpen(true); }
      else if (event.key === "/") { event.preventDefault(); if (onGraph) window.dispatchEvent(new CustomEvent("concentrate:search")); else setPaletteOpen(true); }
      else if (event.key === "f" && onGraph) window.dispatchEvent(new CustomEvent("concentrate:fit"));
      else if (event.key === "Escape") { if (onGraph) window.dispatchEvent(new CustomEvent("concentrate:escape")); else if (focus) select(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [paletteOpen, helpOpen, onGraph, focus, view, project]);

  const inspector = (
    <InspectorPanel
      id={focus ?? null}
      summary={summary?.view === active.id ? summary.node : <p class="muted small">{onGraph ? "Click a node to inspect it." : "Select a row to inspect it."}</p>}
      onSelect={open}
      onClear={() => (onGraph ? navigate({ ...route, focus: undefined, to: undefined }) : select(null))}
      onShowInGraph={onGraph ? undefined : showInGraph}
    />
  );

  return (
    <Shell
      project={project}
      crumbs={[{ label: baseName(project) }, { label: active.label }]}
      nav={nav}
      view={active.id}
      flush={onGraph}
      onNavigate={(next) => navigate({ project, view: next })}
      onHome={() => navigate({ project: null, view: DEFAULT_VIEW })}
      onSearch={() => setPaletteOpen(true)}
      onRescan={() => navigate({ project: null, view: DEFAULT_VIEW, scan: project })}
      inspector={inspector}
    >
      {noGraph ? <NoGraph project={project} onScan={() => navigate({ project: null, view: DEFAULT_VIEW, scan: project })} onChoose={() => navigate({ project: null, view: DEFAULT_VIEW })} /> : <>
      {active.id === "overview" && <Overview key={project} project={project} onOpenView={(next) => navigate({ project, view: next })} onSelect={open} setSummary={setSummary} />}
      {isEntity(active.id) && <EntityView key={active.id} kind={active.id} project={project} selectedId={focus} onSelect={open} setSummary={setSummary} />}
      {active.id === "issues" && <Issues project={project} selectedId={focus} onSelect={open} setSummary={setSummary} />}
      {onGraph && <GraphScreen key={project} project={project} route={route} setSummary={setSummary} />}
      </>}
      {paletteOpen && <CommandPalette onClose={() => setPaletteOpen(false)} onOpenNode={focusInGraph} />}
      {helpOpen && <HelpSheet onClose={() => setHelpOpen(false)} />}
    </Shell>
  );
}

export function App() {
  const route = useRoute();
  useEffect(() => {
    document.title = route.project ? `${baseName(route.project)} · Concentrate` : "Concentrate";
  }, [route.project]);
  return (
    <ErrorBoundary>
      {route.project ? <ProjectScreen project={route.project} view={route.view} route={route} /> : <Start key={route.scan ?? "start"} rescan={route.scan} />}
    </ErrorBoundary>
  );
}

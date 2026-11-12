import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { graphCatalog, graphIssues, setProject, type EntityKind } from "./api.js";
import { InspectorPanel } from "./components/Inspector.js";
import { Shell, type NavItem } from "./components/Shell.js";
import { baseName } from "./lib/format.js";
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
      onSearch={() => window.dispatchEvent(new CustomEvent("concentrate:search"))}
      searchDisabledReason={onGraph ? undefined : "Search works in the Graph view for now; the command palette is coming"}
      onRescan={() => navigate({ project: null, view: DEFAULT_VIEW, scan: project })}
      inspector={inspector}
    >
      {active.id === "overview" && <Overview key={project} project={project} onOpenView={(next) => navigate({ project, view: next })} onSelect={open} setSummary={setSummary} />}
      {isEntity(active.id) && <EntityView key={active.id} kind={active.id} project={project} selectedId={focus} onSelect={open} setSummary={setSummary} />}
      {active.id === "issues" && <Issues project={project} selectedId={focus} onSelect={open} setSummary={setSummary} />}
      {onGraph && <GraphScreen key={project} project={project} route={route} setSummary={setSummary} />}
    </Shell>
  );
}

export function App() {
  const route = useRoute();
  useEffect(() => {
    document.title = route.project ? `${baseName(route.project)} · Concentrate` : "Concentrate";
  }, [route.project]);
  return route.project ? <ProjectScreen project={route.project} view={route.view} route={route} /> : <Start key={route.scan ?? "start"} rescan={route.scan} />;
}

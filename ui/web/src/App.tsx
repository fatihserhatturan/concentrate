import { useEffect, useState } from "preact/hooks";
import { setProject } from "./api.js";
import { Shell, type NavItem } from "./components/Shell.js";
import { baseName } from "./lib/format.js";
import { navigate, useRoute } from "./lib/router.js";
import { LegacyGraph } from "./screens/LegacyGraph.js";
import { Start } from "./screens/Start.js";

// Views are added here as they are built; a view that has nothing to show is left out.
const NAV: NavItem[] = [{ id: "graph", label: "Graph", icon: "graph" }];

function ProjectScreen({ project, view }: { project: string; view: string }) {
  const [inspector, setInspector] = useState<HTMLElement | null>(null);
  setProject(project);
  const active = NAV.find((item) => item.id === view) ?? NAV[0]!;
  const name = baseName(project);
  return (
    <Shell
      project={project}
      crumbs={[{ label: name }, { label: active.label }]}
      nav={NAV}
      view={active.id}
      flush
      onNavigate={(next) => navigate({ project, view: next })}
      onHome={() => navigate({ project: null, view: "graph" })}
      onSearch={() => window.dispatchEvent(new CustomEvent("concentrate:search"))}
      onRescan={() => navigate({ project: null, view: "graph", scan: project })}
      onInspector={setInspector}
    >
      {inspector && <LegacyGraph key={project} inspector={inspector} />}
    </Shell>
  );
}

export function App() {
  const route = useRoute();
  useEffect(() => {
    document.title = route.project ? `${baseName(route.project)} · Concentrate` : "Concentrate";
  }, [route.project]);
  return route.project ? <ProjectScreen project={route.project} view={route.view} /> : <Start key={route.scan ?? "start"} rescan={route.scan} />;
}

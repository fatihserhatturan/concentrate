import { useEffect } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { graphDashboard, graphIssues, projectInfo, type Dashboard } from "../api.js";
import { SummaryList } from "../components/Inspector.js";
import { ErrorState, Loading, ViewHeader } from "../components/State.js";
import { number, timeAgo } from "../lib/format.js";
import { useLoad } from "../lib/useLoad.js";

function Bars({ groups, total }: { groups: Array<{ name: string; count: number }>; total: number }) {
  const shown = groups.slice(0, 7);
  const rest = groups.slice(7).reduce((n, g) => n + g.count, 0);
  const rows = rest > 0 ? [...shown, { name: "other", count: rest }] : shown;
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <ul class="bars">
      {rows.map((r) => (
        <li title={`${r.count.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} files`}>
          <span class="bar-label">{r.name}</span><span class="bar"><span style={{ width: `${(r.count / max) * 100}%` }} /></span><span class="bar-count">{number(r.count)}</span>
        </li>
      ))}
    </ul>
  );
}

function IssuesCard({ project, onOpen }: { project: string; onOpen: (view: string) => void }) {
  const [state, retry] = useLoad(() => graphIssues(), [project]);
  return (
    <section class="card card-pad tile-wide" aria-labelledby="issues-title">
      <h2 id="issues-title">Issues found</h2>
      {state.status === "loading" ? <div class="row muted" style={{ marginTop: "var(--space-3)" }}><div class="spinner" /> Analysing imports and exports…</div>
        : state.status === "error" ? <ErrorState message={state.message} onRetry={retry} />
        : (() => {
          const { cycles, unused, deadFunctions } = state.data;
          const largest = Math.max(0, ...cycles.map((c) => c.size));
          if (cycles.length + unused.length + deadFunctions.length === 0) return <p class="muted" style={{ marginTop: "var(--space-3)" }}>No import cycles and no unused exports. Nothing to fix here.</p>;
          return (
            <ul class="issue-summary">
              {cycles.length > 0 && <li><button onClick={() => onOpen("issues")}><span class="badge badge-warn">{number(cycles.length)}</span> import {cycles.length === 1 ? "cycle" : "cycles"}<span class="muted"> · the largest has {number(largest)} files</span></button></li>}
              {unused.length > 0 && <li><button onClick={() => onOpen("issues")}><span class="badge badge-warn">{number(unused.length)}</span> exports nothing else uses<span class="muted"> · candidates</span></button></li>}
              {deadFunctions.length > 0 && <li><button onClick={() => onOpen("issues")}><span class="badge badge-warn">{number(deadFunctions.length)}</span> functions nothing calls</button></li>}
            </ul>
          );
        })()}
    </section>
  );
}

export function Overview(props: {
  project: string;
  onOpenView: (view: string) => void;
  onSelect: (id: string) => void;
  setSummary: (summary: ComponentChildren) => void;
}) {
  const [state, retry] = useLoad(async () => ({ dashboard: await graphDashboard(), info: await projectInfo(props.project) }), [props.project]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const { dashboard } = state.data;
    props.setSummary(<SummaryList title={dashboard.repo.name || "Project"} subtitle="Files by language" groups={dashboard.languages.map((l) => ({ label: l.name, count: l.count }))} total={dashboard.files.total} hint="Select a file or symbol anywhere to inspect it here." />);
  }, [state]);

  if (state.status === "loading") return <div class="view"><Loading label="Reading the graph…" /></div>;
  if (state.status === "error") return <div class="view"><ErrorState message={state.message} onRetry={retry} /></div>;
  const { dashboard: d, info } = state.data;
  const d2: Dashboard = d;
  return (
    <div class="view">
      <ViewHeader title={d.repo.name || "Overview"} text={`${d.repo.path}`}>
        <div class="muted small">{info.scannedAt ? `Scanned ${timeAgo(info.scannedAt)}` : ""}{d.schemaVersion !== null ? ` · schema ${d.schemaVersion}` : ""}</div>
      </ViewHeader>
      <div class="dash">
        <section class="tiles" aria-label="Counts by kind">
          {d2.kinds.map((k) => (
            <button class="tile" disabled={!k.view} title={k.view ? `Open ${k.label.toLowerCase()}` : "Not listed as a view"} onClick={() => k.view && props.onOpenView(k.view)}>
              <span class="tile-n">{number(k.count)}</span><span class="tile-l">{k.label}</span>
            </button>
          ))}
        </section>
        <IssuesCard project={props.project} onOpen={props.onOpenView} />
        <section class="card card-pad" aria-labelledby="lang-title">
          <h2 id="lang-title">Languages</h2><p class="muted small" style={{ marginBottom: "var(--space-3)" }}>{number(d.files.total)} files{d.files.tests > 0 ? `, ${number(d.files.tests)} of them tests` : ""}</p>
          <Bars groups={d.languages} total={d.files.total} />
        </section>
        {d.packages.length > 0 && (
          <section class="card card-pad" aria-labelledby="pkg-title">
            <h2 id="pkg-title">Packages</h2><p class="muted small" style={{ marginBottom: "var(--space-3)" }}>{d.packages.length} in this project</p>
            <ul class="plain-list">
              {d.packages.slice(0, 8).map((p) => <li><span class="mono">{p.name}</span><span class="muted small">{number(p.files)} files{p.path && p.path !== "." ? ` · ${p.path}` : ""}</span></li>)}
            </ul>
            {d.packages.length > 8 && <p class="muted small">and {d.packages.length - 8} more</p>}
          </section>
        )}
        {d.topFiles.length > 0 && (
          <section class="card card-pad tile-wide" aria-labelledby="top-title">
            <h2 id="top-title">Most connected files</h2><p class="muted small" style={{ marginBottom: "var(--space-3)" }}>Files that other files depend on most. A change here reaches the most code.</p>
            <ul class="plain-list">
              {d.topFiles.map((f) => (
                <li><button class="link-button" onClick={() => props.onSelect(f.id)}><span class="mono">{f.path}</span></button><span class="muted small">used by {number(f.usedBy)} · uses {number(f.uses)}</span></li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}

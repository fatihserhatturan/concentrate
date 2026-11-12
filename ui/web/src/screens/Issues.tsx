import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { graphIssues, type EntityRow, type Issues as IssuesData } from "../api.js";
import { DataTable } from "../components/DataTable.js";
import { SummaryList } from "../components/Inspector.js";
import { ErrorState, Loading, ViewHeader } from "../components/State.js";
import { number } from "../lib/format.js";
import { useLoad } from "../lib/useLoad.js";

type Tab = "cycles" | "unused" | "dead";

const shortName = (file: string) => file.slice(file.lastIndexOf("/") + 1);

function Cycles({ data, onSelect }: { data: IssuesData; onSelect: (id: string) => void }) {
  if (data.cycles.length === 0) return <div class="empty"><h3>No import cycles</h3><p>No group of files imports each other, directly or indirectly.</p></div>;
  return (
    <div class="cycle-list">
      {data.cycles.map((cycle, i) => (
        <article class="card card-pad">
          <div class="row"><h3>{number(cycle.size)} files import each other</h3>{cycle.typeOnly && <span class="badge" title="Every loop goes through a type-only import, which usually disappears at runtime.">type-only</span>}<span class="faint small">#{i + 1}</span></div>
          <p class="muted small" style={{ margin: "var(--space-2) 0" }}>One shortest loop:</p>
          <div class="loop mono">{cycle.cycle.map((file, n) => <><span title={file}>{shortName(file)}</span>{n < cycle.cycle.length - 1 && <span class="faint"> → </span>}</>)}</div>
          <details class="disclosure" style={{ marginTop: "var(--space-3)" }}>
            <summary>{cycle.files.length} {cycle.files.length === 1 ? "file" : "files"} in the loop</summary>
            <div class="disclosure-body"><ul class="plain-list">{cycle.files.map((f) => <li>{f.id ? <button class="link-button" onClick={() => onSelect(f.id!)}><span class="mono">{f.path}</span></button> : <span class="mono">{f.path}</span>}</li>)}</ul></div>
          </details>
        </article>
      ))}
    </div>
  );
}

const unusedColumns = [
  { key: "name", label: "Name", kind: "code" as const }, { key: "kind", label: "Kind", kind: "badge" as const, filter: true },
  { key: "file", label: "File", kind: "code" as const }, { key: "line", label: "Line", kind: "number" as const }, { key: "note", label: "Note" },
];

export function Issues(props: {
  project: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  setSummary: (summary: ComponentChildren) => void;
}) {
  const [state, retry] = useLoad(() => graphIssues(), [props.project]);
  const [tab, setTab] = useState<Tab>("cycles");

  useEffect(() => {
    if (state.status !== "ready") return;
    const { cycles, unused, deadFunctions } = state.data;
    props.setSummary(<SummaryList title="Issues" subtitle="What the analysis found" groups={[
      { label: "Import cycles", count: cycles.length }, { label: "Unused exports", count: unused.length }, { label: "Unused functions", count: deadFunctions.length },
    ]} hint="These are candidates. Select a file or declaration to see where it is used." />);
    if (cycles.length === 0) setTab(unused.length > 0 ? "unused" : "dead");
  }, [state]);

  if (state.status === "loading") return <div class="view"><ViewHeader title="Issues" /><Loading label="Analysing imports and exports…" /></div>;
  if (state.status === "error") return <div class="view"><ViewHeader title="Issues" /><ErrorState message={state.message} onRetry={retry} /></div>;
  const { cycles, unused, deadFunctions, note } = state.data;
  const rows = (items: Array<{ id: string | null; name: string; kind: string; file: string; line: number | null; className?: string; usedInFile?: boolean }>, noteFor: (i: any) => string | null): EntityRow[] =>
    items.map((i) => ({ id: i.id ?? `${i.file}:${i.line}:${i.name}`, name: i.className ? `${i.className}.${i.name}` : i.name, kind: i.kind, file: i.file, line: i.line, note: noteFor(i), hasNode: i.id !== null }));
  const tabs: Array<[Tab, string, number]> = [["cycles", "Import cycles", cycles.length], ["unused", "Unused exports", unused.length], ["dead", "Unused functions", deadFunctions.length]];
  const pick = (row: EntityRow) => { if (row.hasNode) props.onSelect(row.id); };
  return (
    <div class="view">
      <ViewHeader title="Issues" text="Import cycles and code nothing else uses." />
      <div class="alert alert-warn issues-note">{note}</div>
      <div class="tabs" role="tablist">
        {tabs.map(([id, label, count]) => (
          <button role="tab" aria-selected={tab === id} class={tab === id ? "tab active" : "tab"} onClick={() => setTab(id)}>{label} <span class="badge">{number(count)}</span></button>
        ))}
      </div>
      {tab === "cycles" && <Cycles data={state.data} onSelect={props.onSelect} />}
      {tab === "unused" && <DataTable noun="unused exports" columns={unusedColumns} selectedId={props.selectedId} onSelect={pick} rows={rows(unused, (i) => (i.usedInFile ? "used only inside its own file" : null))} empty={{ title: "No unused exports", text: "Every export is used by another file." }} />}
      {tab === "dead" && <DataTable noun="unused functions" columns={unusedColumns} selectedId={props.selectedId} onSelect={pick} rows={rows(deadFunctions, () => null)} empty={{ title: "No unused functions", text: "No file-level function is left without a caller." }} />}
    </div>
  );
}

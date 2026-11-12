import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { graphEntities, type EntityKind, type EntityRow } from "../api.js";
import { DataTable } from "../components/DataTable.js";
import { SummaryList } from "../components/Inspector.js";
import { ErrorState, Loading, ViewHeader } from "../components/State.js";
import { useLoad } from "../lib/useLoad.js";

export const ENTITY_INFO: Record<EntityKind, { title: string; noun: string; text: string; empty: string }> = {
  files: { title: "Files", noun: "files", text: "Every file of the project, with how many other files it uses and is used by.", empty: "The scan found no files." },
  routes: { title: "Routes", noun: "routes", text: "HTTP routes and the functions that handle them.", empty: "No routes were found in this project." },
  tables: { title: "Tables", noun: "tables and models", text: "Database tables and data models, with how often code reads and writes them.", empty: "No tables or data models were found." },
  components: { title: "Components and pages", noun: "components and pages", text: "UI components and router pages, with how often they are rendered.", empty: "No components or pages were found." },
  env: { title: "Env", noun: "env variables", text: "Environment variables the code reads or an env file declares.", empty: "No environment variables were found." },
  entrypoints: { title: "Entrypoints", noun: "entrypoints", text: "Where execution starts: commands, jobs, event handlers and servers.", empty: "No entrypoints were found." },
};

export function EntityView(props: {
  kind: EntityKind;
  project: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  setSummary: (summary: ComponentChildren) => void;
}) {
  const info = ENTITY_INFO[props.kind];
  const [state, retry] = useLoad(() => graphEntities(props.kind), [props.kind, props.project]);

  useEffect(() => {
    if (state.status !== "ready") return;
    const { summary, rows } = state.data;
    props.setSummary(<SummaryList title={info.title} subtitle={`By ${summary.by.toLowerCase()}`} groups={summary.groups} total={rows.length} hint="Select a row to see its source and relationships here." />);
  }, [state]);

  return (
    <div class="view">
      <ViewHeader title={info.title} text={info.text} />
      {state.status === "loading" ? <Loading label={`Loading ${info.noun}…`} />
        : state.status === "error" ? <ErrorState message={state.message} onRetry={retry} />
        : <DataTable noun={info.noun} columns={state.data.columns} rows={state.data.rows} selectedId={props.selectedId} onSelect={(row: EntityRow) => props.onSelect(row.id)} empty={{ title: `No ${info.noun}`, text: info.empty }} />}
    </div>
  );
}

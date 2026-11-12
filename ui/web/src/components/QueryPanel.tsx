import { useState } from "preact/hooks";
import { runQuery, type QueryResult } from "../api.js";

const EXAMPLE = "MATCH (r:Route) RETURN r.method AS method, r.fullPath AS path, id(r) AS id LIMIT 25";

/** A read-only Cypher query (docs/cypher.md). A row with an `id` column opens that node. */
export function QueryPanel(props: { onClose: () => void; onPick: (id: string) => void }) {
  const [query, setQuery] = useState(EXAMPLE);
  const [state, setState] = useState<{ status: "idle" } | { status: "running" } | { status: "error"; message: string } | { status: "ready"; result: QueryResult }>({ status: "idle" });

  const run = async () => {
    setState({ status: "running" });
    try { setState({ status: "ready", result: await runQuery(query) }); }
    catch (error) { setState({ status: "error", message: (error as Error).message }); }
  };
  const cell = (value: unknown) => (value === null || value === undefined ? "" : typeof value === "object" ? JSON.stringify(value) : String(value));

  return (
    <section class="query-panel" aria-label="Cypher query">
      <div class="row"><strong>Cypher</strong><span class="muted small">read-only · {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"}+Enter runs</span><span class="spacer" />
        <button class="btn btn-primary" onClick={run} disabled={state.status === "running"}>Run</button><button class="btn" onClick={props.onClose}>Close</button></div>
      <textarea class="input" rows={3} spellcheck={false} aria-label="Cypher query" value={query} onInput={(e) => setQuery((e.target as HTMLTextAreaElement).value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void run(); } }} />
      <div class="results" aria-live="polite">
        {state.status === "running" && <div class="row muted"><div class="spinner" /> Running…</div>}
        {state.status === "error" && <div class="alert alert-danger">{state.message}</div>}
        {state.status === "ready" && (
          <>
            <p class="muted small">{state.result.total.toLocaleString("en-US")} rows{state.result.truncated ? `, the first ${state.result.rows.length.toLocaleString("en-US")} shown` : ""}</p>
            {state.result.rows.length > 0 && (
              <table class="props">
                <thead><tr>{state.result.columns.map((c) => <th>{c}</th>)}</tr></thead>
                <tbody>{state.result.rows.map((row) => (
                  <tr class={typeof row.id === "string" ? "link" : ""} onClick={() => typeof row.id === "string" && props.onPick(row.id)}>{state.result.columns.map((c) => <td>{cell(row[c])}</td>)}</tr>
                ))}</tbody>
              </table>
            )}
          </>
        )}
      </div>
    </section>
  );
}

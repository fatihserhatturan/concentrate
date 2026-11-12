import type { ComponentChildren } from "preact";
import { useEffect, useState } from "preact/hooks";
import { graphNode, graphSource, type NodeDetail } from "../api.js";
import { color } from "../graph/colors.js";
import { highlightSource } from "../lib/highlight.js";
import { Icon } from "./icons.js";

type Source = Awaited<ReturnType<typeof graphSource>>;

/** The view's summary: counts by one grouping, as bars. Shown while nothing is selected. */
export function SummaryList(props: { title: string; subtitle?: string; groups: Array<{ label: string; count: number }>; total?: number; hint?: string }) {
  const max = Math.max(1, ...props.groups.map((g) => g.count));
  const total = props.total ?? props.groups.reduce((n, g) => n + g.count, 0);
  return (
    <div class="stack">
      <div><h3>{props.title}</h3>{props.subtitle && <p class="muted small">{props.subtitle}</p>}</div>
      <div class="kv"><div><span class="v">{total.toLocaleString("en-US")}</span><span class="k">total</span></div></div>
      <ul class="bars">
        {props.groups.slice(0, 12).map((g) => (
          <li><span class="bar-label" title={g.label}>{g.label}</span><span class="bar"><span style={{ width: `${(g.count / max) * 100}%` }} /></span><span class="bar-count">{g.count.toLocaleString("en-US")}</span></li>
        ))}
      </ul>
      {props.groups.length > 12 && <p class="muted small">and {props.groups.length - 12} more</p>}
      {props.hint && <p class="muted small">{props.hint}</p>}
    </div>
  );
}

function SourceView({ source, file }: { source: Source; file: string | null }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setHtml(null);
    if (source.source) highlightSource(source.source, source.file ?? file).then((value) => { if (!cancelled) setHtml(value); });
    return () => { cancelled = true; };
  }, [source.source, source.file, file]);
  if (!source.source) return <p class="muted small">{source.note ?? "No source to show."}</p>;
  return (
    <div>
      <div class="muted xs" style={{ marginBottom: "var(--space-1)" }}>{source.file}:{source.line}{source.endLine && source.endLine !== source.line ? `–${source.endLine}` : ""}</div>
      <pre class="code"><code dangerouslySetInnerHTML={{ __html: html ?? source.source.replace(/&/g, "&amp;").replace(/</g, "&lt;") }} /></pre>
      {source.truncated && <p class="muted xs">The source is cut after 400 lines.</p>}
    </div>
  );
}

/** The selected node: kind, location, highlighted source and clickable relationships by type. */
export function InspectorPanel(props: {
  id: string | null;
  /** Rendered while nothing is selected. */
  summary: ComponentChildren;
  onSelect: (id: string) => void;
  onClear: () => void;
  /** Left out where the graph is already showing the node. */
  onShowInGraph?: (id: string) => void;
}) {
  const [state, setState] = useState<{ status: "idle" } | { status: "loading" } | { status: "error"; message: string } | { status: "ready"; detail: NodeDetail; source: Source | null }>({ status: "idle" });

  useEffect(() => {
    if (!props.id) { setState({ status: "idle" }); return; }
    let cancelled = false;
    setState({ status: "loading" });
    Promise.all([graphNode(props.id), graphSource(props.id).catch(() => null)]).then(
      ([detail, source]) => { if (!cancelled) setState({ status: "ready", detail, source }); },
      (error) => { if (!cancelled) setState({ status: "error", message: (error as Error).message }); },
    );
    return () => { cancelled = true; };
  }, [props.id]);

  if (!props.id || state.status === "idle") return <>{props.summary}</>;
  if (state.status === "loading") return <div class="row muted"><div class="spinner" /> Loading…</div>;
  if (state.status === "error") {
    return <div class="stack"><div class="alert alert-danger">{state.message}</div><button class="btn" onClick={props.onClear}>Close</button></div>;
  }
  const { detail, source } = state;
  const groups = (items: NodeDetail["outgoing"]) => Object.entries(items).filter(([, list]) => list.length > 0);
  const relations = (title: string, items: NodeDetail["outgoing"]) => {
    const entries = groups(items);
    if (entries.length === 0) return null;
    return (
      <section>
        <h4 class="section-h">{title}</h4>
        {entries.map(([type, list]) => (
          <div class="rel-group">
            <div class="rel-type">{type.replace(/_/g, " ").toLowerCase()} <span class="faint">{list.length}</span></div>
            <ul class="rel-list">
              {list.map((item) => (
                <li><button onClick={() => props.onSelect(item.id)} title={`${item.label}: ${item.name}`}><span class="dot" style={{ background: color(item.label) }} />{item.name}<span class="faint xs">{item.label}</span></button></li>
              ))}
            </ul>
          </div>
        ))}
      </section>
    );
  };
  const properties = Object.entries(detail.properties).filter(([k]) => k !== "path");
  return (
    <div class="stack insp">
      <div>
        <div class="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
          <span class="badge"><span class="dot" style={{ background: color(detail.label), marginRight: 0 }} />{detail.label}</span>
          <button class="btn btn-ghost btn-icon" onClick={props.onClear} title="Close the inspector selection" aria-label="Close selection"><Icon name="x" /></button>
        </div>
        <h3 class="insp-title">{detail.name}</h3>
        {detail.file && <div class="mono muted xs insp-path" title={detail.file}>{detail.file}{detail.line ? `:${detail.line}` : ""}</div>}
      </div>
      {props.onShowInGraph && (
        <div class="row">
          <button class="btn btn-primary" onClick={() => props.onShowInGraph!(detail.id)}><Icon name="graph" /> Show in graph</button>
        </div>
      )}
      {source && <section><h4 class="section-h">Source</h4><SourceView source={source} file={detail.file} /></section>}
      {relations("Uses (outgoing)", detail.outgoing)}
      {relations("Used by (incoming)", detail.incoming)}
      {properties.length > 0 && (
        <details class="disclosure"><summary>Properties ({properties.length})</summary>
          <div class="disclosure-body"><table class="props"><tbody>{properties.map(([k, v]) => <tr><td>{k}</td><td>{typeof v === "string" && v.length > 160 ? `${v.slice(0, 160)}…` : String(v)}</td></tr>)}</tbody></table></div>
        </details>
      )}
    </div>
  );
}

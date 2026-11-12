import { useEffect, useRef, useState } from "preact/hooks";
import { exportUrl } from "../api.js";

/** Format and scope of an export; the download is a plain link, streamed by the server. */
export function ExportDialog(props: { open: boolean; onClose: () => void; types: string[]; prefix: string; focus?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [format, setFormat] = useState("json");
  const [scope, setScope] = useState<"graph" | "view">("graph");

  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (props.open && !element.open) element.showModal();
    if (!props.open && element.open) element.close();
  }, [props.open]);

  const note = scope === "view"
    ? props.focus ? "The focused node, its neighbours and the relationships shown." : `The files${props.prefix ? ` under /${props.prefix}` : ""} and the relationships between them, for the selected relationship kinds.`
    : "Every node and relationship of the stored graph. DOT and HTML use the file level above 5,000 nodes.";

  return (
    <dialog ref={dialog} onClose={props.onClose} class="dialog" aria-labelledby="export-title">
      <div class="stack" style={{ minWidth: 340 }}>
        <h2 id="export-title">Export</h2>
        <div class="field"><label for="export-format">Format</label>
          <select id="export-format" class="input" value={format} onChange={(e) => setFormat((e.target as HTMLSelectElement).value)}>
            <option value="json">JSON (one file)</option><option value="jsonl">JSONL (zip: nodes, relationships, summary)</option>
            <option value="graphml">GraphML (Gephi, yEd)</option><option value="dot">DOT (Graphviz)</option><option value="html">HTML (self-contained viewer)</option>
          </select></div>
        <div class="field"><label for="export-scope">Scope</label>
          <select id="export-scope" class="input" value={scope} onChange={(e) => setScope((e.target as HTMLSelectElement).value as "graph" | "view")}>
            <option value="graph">Whole graph</option><option value="view">Current view</option>
          </select></div>
        <p class="muted small">{note}</p>
        <div class="row" style={{ justifyContent: "flex-end" }}>
          <button class="btn" onClick={props.onClose}>Close</button>
          <a class="btn btn-primary" data-testid="export-download" href={exportUrl({ format, scope, types: props.types, prefix: props.prefix, focus: props.focus })} download onClick={() => setTimeout(props.onClose, 100)}>Download</a>
        </div>
      </div>
    </dialog>
  );
}

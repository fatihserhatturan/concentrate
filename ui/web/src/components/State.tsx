import type { ComponentChildren } from "preact";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div class="empty" role="status"><div class="spinner" style={{ margin: "0 auto var(--space-3)" }} /><p>{label}</p></div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  // A wrong token means the server restarted or the page was opened without the address it printed.
  const lost = /token/i.test(message);
  return (
    <div class="empty" role="alert">
      <h3>{lost ? "This page lost its session" : "Something went wrong"}</h3>
      <p>{lost ? "The server was restarted, or this page was opened without the address it printed. Open that address again (it carries a fresh token)." : message}</p>
      {onRetry && <p style={{ marginTop: "var(--space-3)" }}><button class="btn" onClick={onRetry}>Try again</button></p>}
    </div>
  );
}

export function ViewHeader(props: { title: string; text?: string; children?: ComponentChildren }) {
  return (
    <header class="view-header">
      <div><h1>{props.title}</h1>{props.text && <p class="muted">{props.text}</p>}</div>
      {props.children}
    </header>
  );
}

/** Shown in place of a view when the project has no graph yet (never scanned, or the folder is gone). */
export function NoGraph(props: { project: string; onScan: () => void; onChoose: () => void }) {
  return (
    <div class="empty" style={{ paddingTop: "var(--space-7)" }}>
      <h3>No graph for this project yet</h3>
      <p>Nothing has been scanned in <span class="mono">{props.project}</span>, or the folder is gone.</p>
      <p class="row" style={{ justifyContent: "center", marginTop: "var(--space-4)" }}>
        <button class="btn btn-primary" onClick={props.onScan}>Scan this project</button>
        <button class="btn" onClick={props.onChoose}>Choose another project</button>
      </p>
    </div>
  );
}

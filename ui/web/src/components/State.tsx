import type { ComponentChildren } from "preact";

export function Loading({ label = "Loading…" }: { label?: string }) {
  return <div class="empty" role="status"><div class="spinner" style={{ margin: "0 auto var(--space-3)" }} /><p>{label}</p></div>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="empty" role="alert">
      <h3>Something went wrong</h3>
      <p>{message}</p>
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

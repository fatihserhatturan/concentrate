import { useErrorBoundary } from "preact/hooks";
import type { ComponentChildren } from "preact";

/** A screen that throws shows this instead of a blank page. */
export function ErrorBoundary({ children }: { children: ComponentChildren }) {
  const [error, reset] = useErrorBoundary((caught) => console.error(caught));
  if (!error) return <>{children}</>;
  return (
    <div class="empty" role="alert" style={{ paddingTop: "var(--space-7)" }}>
      <h3>The interface hit an unexpected error</h3>
      <p class="mono">{error instanceof Error ? error.message : String(error)}</p>
      <p class="row" style={{ justifyContent: "center", marginTop: "var(--space-4)" }}>
        <button class="btn btn-primary" onClick={() => location.reload()}>Reload the page</button>
        <button class="btn" onClick={reset}>Try again</button>
      </p>
    </div>
  );
}

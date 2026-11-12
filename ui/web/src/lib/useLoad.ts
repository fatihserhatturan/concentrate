import { useEffect, useState } from "preact/hooks";

export type Loaded<T> = { status: "loading" } | { status: "error"; message: string } | { status: "ready"; data: T };

/** Runs an async loader when its inputs change; the result is loading, an error, or the data. */
export function useLoad<T>(load: () => Promise<T>, inputs: unknown[]): [Loaded<T>, () => void] {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    load().then(
      (data) => { if (!cancelled) setState({ status: "ready", data }); },
      (error) => { if (!cancelled) setState({ status: "error", message: (error as Error).message }); },
    );
    return () => { cancelled = true; };
  }, [...inputs, attempt]);
  return [state, () => setAttempt((n) => n + 1)];
}

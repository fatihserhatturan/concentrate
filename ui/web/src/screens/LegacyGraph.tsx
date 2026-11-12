import { useEffect, useRef } from "preact/hooks";
import { mountGraphView } from "../views/graph.js";

/** Hosts the first-stage graph view; stage 3 replaces it with the focus-mode graph. */
export function LegacyGraph({ inspector }: { inspector: HTMLElement }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => (root.current ? mountGraphView(root.current, { inspector }) : undefined), [inspector]);
  return <div ref={root} style={{ height: "100%" }} />;
}

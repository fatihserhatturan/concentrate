import { useEffect, useRef } from "preact/hooks";
import { mountGraphView } from "../views/graph.js";

/** Hosts the first-stage graph view; stage 3 replaces it with the focus-mode graph. */
export function LegacyGraph({ inspector, focus }: { inspector: HTMLElement; focus?: string }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => (root.current ? mountGraphView(root.current, { inspector, focus }) : undefined), [inspector, focus]);
  return <div ref={root} style={{ height: "100%" }} />;
}

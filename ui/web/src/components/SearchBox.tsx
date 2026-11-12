import { useEffect, useRef, useState } from "preact/hooks";
import { graphSearch, type SearchResult } from "../api.js";
import { color } from "../graph/colors.js";

/** Symbol and file search; picking a result refocuses the graph on it. */
export function SearchBox({ onPick }: { onPick: (id: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [hits, setHits] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState(0);

  useEffect(() => {
    const focus = () => input.current?.focus();
    window.addEventListener("concentrate:search", focus);
    return () => window.removeEventListener("concentrate:search", focus);
  }, []);

  useEffect(() => {
    const q = text.trim();
    if (!q) { setHits(null); setError(null); return; }
    let cancelled = false;
    const timer = setTimeout(() => {
      graphSearch(q).then(
        ({ results }) => { if (!cancelled) { setHits(results.slice(0, 12)); setActive(0); setError(null); } },
        (e) => { if (!cancelled) setError((e as Error).message); },
      );
    }, 180);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [text]);

  const pick = (id: string) => { setText(""); setHits(null); input.current?.blur(); onPick(id); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { setText(""); setHits(null); input.current?.blur(); }
    else if (event.key === "ArrowDown" && hits) { event.preventDefault(); setActive((a) => Math.min(hits.length - 1, a + 1)); }
    else if (event.key === "ArrowUp" && hits) { event.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (event.key === "Enter" && hits?.[active]) { event.preventDefault(); pick(hits[active]!.id); }
  };

  return (
    <div class="search-box">
      <input ref={input} class="input" type="search" placeholder="Find a symbol or file…" aria-label="Find a symbol or file" value={text} onInput={(e) => setText((e.target as HTMLInputElement).value)} onKeyDown={onKey} />
      {(hits || error) && (
        <ul class="hit-list" role="listbox">
          {error ? <li class="faint small" style={{ padding: "var(--space-2)" }}>{error}</li>
            : hits!.length === 0 ? <li class="faint small" style={{ padding: "var(--space-2)" }}>No match</li>
            : hits!.map((hit, i) => (
              <li><button role="option" aria-selected={i === active} onMouseEnter={() => setActive(i)} onClick={() => pick(hit.id)}>
                <span class="dot" style={{ background: color(hit.label) }} />{hit.name}<span class="hit-file">{hit.label}{hit.file && hit.label !== "File" ? ` · ${hit.file}` : ""}</span>
              </button></li>
            ))}
        </ul>
      )}
    </div>
  );
}

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { graphSearch, type SearchResult } from "../api.js";
import { color } from "../graph/colors.js";
import { rankCommands, useCommandList, type Command } from "../lib/commands.js";
import { Icon } from "./icons.js";

type Item =
  | { kind: "command"; command: Command }
  | { kind: "symbol"; hit: SearchResult };

const MAX_COMMANDS_TYPED = 8;

/** Cmd/Ctrl+K: actions and views first, then symbols, files and routes from the graph. */
export function CommandPalette(props: { onClose: () => void; onOpenNode: (id: string) => void }) {
  const commands = useCommandList();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [active, setActive] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  // A list that re-renders under a still mouse makes the browser send a mousemove; only a real move may take the selection.
  const mouse = useRef({ x: -1, y: -1 });
  const hover = (i: number) => (event: MouseEvent) => {
    if (event.clientX === mouse.current.x && event.clientY === mouse.current.y) return;
    mouse.current = { x: event.clientX, y: event.clientY };
    setActive(i);
  };

  // Focus the moment the palette is in the DOM, before the browser paints: keys typed right after opening must not be lost.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    return () => previous?.focus?.();
  }, []);

  useEffect(() => {
    const q = query.trim();
    setMessage(null);
    if (q.length < 2) { setHits([]); setSearching(false); return; }
    let cancelled = false;
    setSearching(true);
    const timer = setTimeout(() => {
      graphSearch(q).then(
        ({ results }) => { if (!cancelled) { setHits(results.slice(0, 10)); setSearching(false); } },
        () => { if (!cancelled) { setHits([]); setSearching(false); } },
      );
    }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [query]);

  const items = useMemo<Item[]>(() => {
    const ranked = rankCommands(commands, query);
    const shown = query.trim() ? ranked.slice(0, MAX_COMMANDS_TYPED) : ranked;
    return [...shown.map((command): Item => ({ kind: "command", command })), ...hits.map((hit): Item => ({ kind: "symbol", hit }))];
  }, [commands, query, hits]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" }); }, [active, items]);

  const choose = (item: Item | undefined) => {
    if (!item) return;
    if (item.kind === "symbol") { props.onClose(); props.onOpenNode(item.hit.id); return; }
    if (item.command.disabledReason) { setMessage(item.command.disabledReason); return; }
    props.onClose();
    item.command.run();
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); props.onClose(); }
    else if (event.key === "ArrowDown") { event.preventDefault(); setActive((a) => Math.min(items.length - 1, a + 1)); }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (event.key === "Enter") { event.preventDefault(); choose(items[active]); }
  };

  let lastGroup = "";
  return (
    <div class="palette-backdrop" onMouseDown={props.onClose}>
      <div class="palette" role="dialog" aria-modal="true" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey}>
        <div class="palette-input">
          <Icon name="search" />
          <input ref={input} placeholder="Type a command, or search symbols, files and routes…" aria-label="Command or search" role="combobox" aria-expanded="true" aria-controls="palette-list" value={query} onInput={(e) => setQuery((e.target as HTMLInputElement).value)} spellcheck={false} />
          {searching && <div class="spinner" aria-label="Searching" />}
          <span class="kbd">Esc</span>
        </div>
        <ul class="palette-list" id="palette-list" role="listbox" ref={list}>
          {items.map((item, i) => {
            const group = item.kind === "command" ? item.command.group : "Symbols, files and routes";
            const heading = group !== lastGroup ? <li class="palette-group" role="presentation">{group}</li> : null;
            lastGroup = group;
            return (
              <>
                {heading}
                <li role="option" aria-selected={i === active} aria-disabled={item.kind === "command" && !!item.command.disabledReason} class={`palette-item${i === active ? " active" : ""}${item.kind === "command" && item.command.disabledReason ? " disabled" : ""}`} onMouseMove={hover(i)} onClick={() => choose(item)}>
                  {item.kind === "command" ? (
                    <>
                      <span class="palette-title">{item.command.title}</span>
                      {item.command.disabledReason && <span class="palette-reason">{item.command.disabledReason}</span>}
                      {item.command.shortcut && <span class="kbd">{item.command.shortcut}</span>}
                    </>
                  ) : (
                    <>
                      <span class="dot" style={{ background: color(item.hit.label) }} />
                      <span class="palette-title">{item.hit.name}</span>
                      <span class="palette-reason">{item.hit.label}{item.hit.file && item.hit.label !== "File" ? ` · ${item.hit.file}` : ""}</span>
                    </>
                  )}
                </li>
              </>
            );
          })}
          {items.length === 0 && !searching && <li class="palette-empty">{query.trim().length < 2 ? "No commands are available here." : "Nothing matches. Try part of a name."}</li>}
        </ul>
        <div class="palette-foot" aria-live="polite">{message ? <span class="palette-message">{message}</span> : <><span><span class="kbd">↑</span> <span class="kbd">↓</span> move</span><span><span class="kbd">↵</span> choose</span><span><span class="kbd">Esc</span> close</span></>}</div>
      </div>
    </div>
  );
}

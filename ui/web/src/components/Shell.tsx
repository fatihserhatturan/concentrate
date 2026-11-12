import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon, type IconName } from "./icons.js";
import { modifierKey } from "../lib/commands.js";
import { useTheme } from "../lib/theme.js";

export type NavItem = { id: string; label: string; icon: IconName; count?: number; group?: string };
export type Crumb = { label: string; onClick?: () => void };

const INSPECTOR_KEY = "concentrate-inspector-width";
const MIN = 280;
const MAX = 720;

function storedWidth(): number {
  try {
    const value = Number(localStorage.getItem(INSPECTOR_KEY));
    return value >= MIN && value <= MAX ? value : 360;
  } catch {
    return 360;
  }
}

// The app icon: a ring around one node, three edges out to three nodes (docs/assets/brand/icon.svg).
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg class="logo" width={size} height={size} viewBox="0 0 56 56" aria-hidden="true">
      <rect width="56" height="56" rx="14" fill="var(--brand-tile)" />
      <g fill="none" stroke="var(--brand-ink)" stroke-width="3.5" stroke-linecap="round">
        <circle cx="28" cy="28" r="10" />
        <path d="M20.5 21.4L10 12M35.9 21.9L46 14M33.6 36.3L40 46" />
      </g>
      <g fill="var(--brand-ink)">
        <circle cx="28" cy="28" r="3.6" /><circle cx="10" cy="12" r="3.6" /><circle cx="46" cy="14" r="3.6" /><circle cx="40" cy="46" r="3.6" />
      </g>
    </svg>
  );
}

const WORDMARK_STROKES = [
  "M30.7 29.3A18 18 0 1 0 30.7 54.7",
  "M91 60L91 24M91 42A16 18 0 0 1 123 42L123 60",
  "M165.7 29.3A18 18 0 1 0 165.7 54.7",
  "M178 42L214 42A18 18 0 1 0 208.7 54.7",
  "M226 60L226 24M226 42A16 18 0 0 1 258 42L258 60",
  "M276 10L276 48Q276 60 288 60L290 60M266 24L290 24",
  "M302 60L302 24M302 42A20 18 0 0 1 322 24",
  "M368 24L368 60",
  "M388 10L388 48Q388 60 400 60L402 60M378 24L402 24",
  "M414 42L450 42A18 18 0 1 0 444.7 54.7",
].join("");
// Stroke ends of the letters; the first is the centre of the o.
const WORDMARK_NODES: ReadonlyArray<readonly [number, number]> = [
  [61, 42], [30.7, 29.3], [30.7, 54.7], [91, 24], [91, 60], [123, 60], [165.7, 29.3], [165.7, 54.7], [208.7, 54.7],
  [226, 24], [226, 60], [258, 60], [276, 10], [290, 60], [302, 24], [302, 60], [322, 24],
  [368, 24], [368, 60], [388, 10], [402, 60], [444.7, 54.7],
];

// "concentrate" as drawn in docs/assets/brand/wordmark-*.svg: strokes in the text colour, nodes in the brand colour.
export function Wordmark({ height = 18 }: { height?: number }) {
  return (
    <svg class="wordmark" height={height} width={(height * 467) / 70} viewBox="-6 0 467 70" role="img" aria-label="Concentrate">
      <g fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="61" cy="42" r="18" /><circle cx="350" cy="42" r="18" />
        <path d={WORDMARK_STROKES} />
      </g>
      <g fill="var(--brand)">
        {WORDMARK_NODES.map(([x, y], index) => <circle cx={x} cy={y} r={index === 0 ? 5 : 4.4} />)}
      </g>
    </svg>
  );
}

export function ThemeButton() {
  const [theme, toggle] = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <button class="btn btn-ghost btn-icon" onClick={toggle} title={`Switch to ${next} theme`} aria-label={`Switch to ${next} theme`}>
      <Icon name={theme === "dark" ? "sun" : "moon"} />
    </button>
  );
}

/** A right-hand panel whose left edge can be dragged; the width is remembered. */
function Inspector({ children }: { children: ComponentChildren }) {
  const [width, setWidth] = useState(storedWidth);
  const [dragging, setDragging] = useState(false);
  const start = useRef({ x: 0, width: 0 });

  useEffect(() => {
    if (!dragging) return;
    const move = (event: PointerEvent) => setWidth(Math.min(MAX, Math.max(MIN, start.current.width + (start.current.x - event.clientX))));
    const up = () => setDragging(false);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.style.userSelect = "none";
    return () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.style.userSelect = "";
      try { localStorage.setItem(INSPECTOR_KEY, String(width)); } catch { /* storage unavailable */ }
    };
  }, [dragging]);

  const onKey = (event: KeyboardEvent) => {
    if (event.key === "ArrowLeft") setWidth((w) => Math.min(MAX, w + 24));
    if (event.key === "ArrowRight") setWidth((w) => Math.max(MIN, w - 24));
  };

  return (
    <aside class="inspector" style={{ width }} aria-label="Inspector">
      <div
        class={`resize-handle${dragging ? " active" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-valuemin={MIN}
        aria-valuemax={MAX}
        aria-valuenow={width}
        tabIndex={0}
        title="Drag to resize"
        onPointerDown={(event) => { start.current = { x: event.clientX, width }; setDragging(true); }}
        onKeyDown={onKey}
      />
      <div class="inspector-head">Inspector</div>
      <div class="inspector-body">{children}</div>
    </aside>
  );
}

export function Shell(props: {
  project: string;
  crumbs: Crumb[];
  nav: NavItem[];
  view: string;
  onNavigate: (view: string) => void;
  onHome: () => void;
  onSearch: () => void;
  onRescan: () => void;
  /** The inspector's content: the selected node, or the summary of the current view. */
  inspector: ComponentChildren;
  flush?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class="shell">
      <header class="topbar">
        <button class="brand" onClick={props.onHome} title="Back to the start screen">
          <Logo /> <Wordmark />
        </button>
        <nav class="crumbs" aria-label="Breadcrumb">
          {props.crumbs.map((crumb, i) => (
            <>
              {i > 0 && <span class="sep" aria-hidden="true">/</span>}
              {crumb.onClick ? <button onClick={crumb.onClick}>{crumb.label}</button> : <strong title={i === 0 ? props.project : undefined}>{crumb.label}</strong>}
            </>
          ))}
        </nav>
        <span class="spacer" />
        <button class="search-trigger" onClick={props.onSearch} aria-label="Search and commands" title={`Search and commands (${modifierKey()}+K)`}>
          <Icon name="search" /> <span>Search and commands</span> <span class="kbd">{modifierKey()} K</span>
        </button>
        <button class="btn btn-ghost" onClick={props.onRescan} title="Scan this project again (the parse cache keeps it fast)">
          <Icon name="refresh" /> Rescan
        </button>
        <ThemeButton />
      </header>
      <div class="workspace">
        <nav class="nav" aria-label="Views">
          {props.nav.map((item, i) => (
            <>
              {item.group && item.group !== props.nav[i - 1]?.group && <div class="nav-heading">{item.group}</div>}
              <button class="nav-item" aria-current={item.id === props.view ? "page" : undefined} onClick={() => props.onNavigate(item.id)}>
              <Icon name={item.icon} /> <span class="label">{item.label}</span>
              {item.count !== undefined && <span class="count">{item.count.toLocaleString("en-US")}</span>}
              </button>
            </>
          ))}
        </nav>
        <main class={`main${props.flush ? " flush" : ""}`}>{props.children}</main>
        <Inspector>{props.inspector}</Inspector>
      </div>
    </div>
  );
}

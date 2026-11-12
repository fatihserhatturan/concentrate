import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Icon, type IconName } from "./icons.js";
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

export function Logo({ size = 20 }: { size?: number }) {
  return (
    <svg class="logo" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <rect width="16" height="16" rx="4" fill="var(--accent)" />
      <circle cx="8" cy="8" r="2.4" fill="var(--accent-fg)" />
      <circle cx="8" cy="8" r="5.2" fill="none" stroke="var(--accent-fg)" stroke-width="1.2" opacity=".7" />
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
  /** Set when search cannot be used in the current view; the button then says why. */
  searchDisabledReason?: string;
  flush?: boolean;
  children: ComponentChildren;
}) {
  return (
    <div class="shell">
      <header class="topbar">
        <button class="brand" onClick={props.onHome} title="Back to the start screen">
          <Logo /> Concentrate
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
        <button class="search-trigger" onClick={props.onSearch} aria-label="Search" disabled={!!props.searchDisabledReason} title={props.searchDisabledReason}>
          <Icon name="search" /> <span>Search symbols and files</span> <span class="kbd">/</span>
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

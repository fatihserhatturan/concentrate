import { useEffect, useState } from "preact/hooks";

export const DEFAULT_VIEW = "overview";

/** The whole UI state that belongs in the URL: which project, which view, which node is focused. */
export type Route = {
  /** Project path, null on the start screen. */
  project: string | null;
  view: string;
  /** The node the graph is about (and the inspector shows). */
  focus?: string;
  /** Graph: a second node; the graph then shows the path from `focus` to it. */
  to?: string;
  /** Graph overview: "package", "directory" or "file", and the folder it is drilled into. */
  level?: string;
  prefix?: string;
  /** Graph focus: how many steps each way. */
  depth?: number;
  /** Graph: enabled relationship categories (comma separated); absent means the defaults. */
  show?: string;
  /** Graph overview: show dot-directories and build output. */
  noise?: boolean;
  /** Graph: a question (preset) to show. */
  preset?: string;
  /** Start screen only: scan this path right away (the shell's Rescan). */
  scan?: string;
};

export function parseRoute(search: string): Route {
  const params = new URLSearchParams(search);
  const project = params.get("project");
  return {
    project: project && project.length > 0 ? project : null,
    view: params.get("view") ?? DEFAULT_VIEW,
    focus: params.get("focus") ?? undefined,
    to: params.get("to") ?? undefined,
    level: params.get("level") ?? undefined,
    prefix: params.get("prefix") ?? undefined,
    depth: params.has("depth") ? Number(params.get("depth")) : undefined,
    show: params.get("show") ?? undefined,
    noise: params.get("noise") === "1" ? true : undefined,
    preset: params.get("preset") ?? undefined,
    scan: params.get("scan") ?? undefined,
  };
}

export function formatRoute(route: Route): string {
  const params = new URLSearchParams();
  if (route.project) {
    params.set("project", route.project);
    if (route.view !== DEFAULT_VIEW) params.set("view", route.view);
    if (route.focus) params.set("focus", route.focus);
    if (route.to) params.set("to", route.to);
    if (route.level) params.set("level", route.level);
    if (route.prefix) params.set("prefix", route.prefix);
    if (route.depth && route.depth > 1) params.set("depth", String(route.depth));
    if (route.show !== undefined) params.set("show", route.show);
    if (route.noise) params.set("noise", "1");
    if (route.preset) params.set("preset", route.preset);
  } else if (route.scan) params.set("scan", route.scan);
  const query = params.toString();
  return query ? `/?${query}` : "/";
}

const listeners = new Set<() => void>();

/** Moves to a route with the History API, so back and forward work. */
export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  const url = formatRoute(route);
  if (url === location.pathname + location.search) return;
  if (options.replace) history.replaceState(null, "", url);
  else history.pushState(null, "", url);
  listeners.forEach((listener) => listener());
}

window.addEventListener("popstate", () => listeners.forEach((listener) => listener()));

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.search));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.search));
    listeners.add(update);
    return () => { listeners.delete(update); };
  }, []);
  return route;
}

import { useEffect, useState } from "preact/hooks";

export const DEFAULT_VIEW = "overview";

/** The whole UI state that belongs in the URL: which project, which view, which node is focused. */
export type Route = {
  /** Project path, null on the start screen. */
  project: string | null;
  view: string;
  focus?: string;
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
    scan: params.get("scan") ?? undefined,
  };
}

export function formatRoute(route: Route): string {
  const params = new URLSearchParams();
  if (route.project) {
    params.set("project", route.project);
    if (route.view !== DEFAULT_VIEW) params.set("view", route.view);
    if (route.focus) params.set("focus", route.focus);
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

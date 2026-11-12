// Recent projects live in this browser only (localStorage); every access is guarded.
const KEY = "concentrate-recent-projects";
const LIMIT = 8;

export type RecentProject = { path: string; openedAt: number };

export function loadRecents(): RecentProject[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((r) => r && typeof r.path === "string").slice(0, LIMIT) : [];
  } catch {
    return [];
  }
}

function save(list: RecentProject[]): void {
  try { localStorage.setItem(KEY, JSON.stringify(list.slice(0, LIMIT))); } catch { /* storage unavailable */ }
}

export function rememberProject(path: string): void {
  save([{ path, openedAt: Date.now() }, ...loadRecents().filter((r) => r.path !== path)]);
}

export function forgetProject(path: string): RecentProject[] {
  const list = loadRecents().filter((r) => r.path !== path);
  save(list);
  return list;
}

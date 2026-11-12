// The ten relationship kinds of the server are shown as five categories: few enough to tell apart.
export type CategoryId = "imports" | "calls" | "web" | "data" | "structure";

export type Category = { id: CategoryId; label: string; hint: string; kinds: string[]; dash?: string };

export const CATEGORIES: Category[] = [
  { id: "imports", label: "Imports", hint: "Files importing files, re-exports, package dependencies", kinds: ["imports"] },
  { id: "calls", label: "Calls and types", hint: "Calls, extends, implements, injection, hooks", kinds: ["calls", "types", "di", "other"] },
  { id: "web", label: "Routes and UI", hint: "Routes and handlers, frontend requests, rendering, stores, styles", kinds: ["routes", "requests", "renders"] },
  { id: "data", label: "Data and config", hint: "Tables and models, environment variables and config", kinds: ["data", "env"] },
  { id: "structure", label: "Structure", hint: "Which file or class declares what", kinds: ["defines"], dash: "4 3" },
];

export const DEFAULT_ENABLED: CategoryId[] = ["imports", "calls", "web", "data"];

const byKind = new Map(CATEGORIES.flatMap((c) => c.kinds.map((k) => [k, c] as const)));

export const categoryOfKind = (kind: string): Category => byKind.get(kind) ?? CATEGORIES[1]!;
export const kindsOf = (enabled: Iterable<CategoryId>): string[] => CATEGORIES.filter((c) => new Set(enabled).has(c.id)).flatMap((c) => c.kinds);

export function parseEnabled(value: string | undefined): Set<CategoryId> {
  if (value === undefined) return new Set(DEFAULT_ENABLED);
  const ids = new Set(CATEGORIES.map((c) => c.id as string));
  return new Set(value.split(",").filter((id) => ids.has(id)) as CategoryId[]);
}

/** The colour of a category as the current theme defines it (WebGL cannot read CSS variables). */
export function categoryColor(id: CategoryId): string {
  return getComputedStyle(document.documentElement).getPropertyValue(`--cat-${id}`).trim() || "#8b949e";
}

export function themeColor(name: string, fallback: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

import { useEffect, useState } from "preact/hooks";

export type Theme = "light" | "dark";
const KEY = "concentrate-theme";

const systemDark = () => matchMedia("(prefers-color-scheme: dark)").matches;

function stored(): Theme | null {
  try {
    const value = localStorage.getItem(KEY);
    return value === "light" || value === "dark" ? value : null;
  } catch {
    return null;
  }
}

export function currentTheme(): Theme {
  return (document.documentElement.dataset.theme as Theme | undefined) ?? (systemDark() ? "dark" : "light");
}

function apply(theme: Theme | null): void {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  window.dispatchEvent(new CustomEvent("concentrate:theme", { detail: { dark: currentTheme() === "dark" } }));
}

/** Follows the system until the toggle is used. */
export function initTheme(): void {
  apply(stored());
}

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(currentTheme);
  useEffect(() => {
    const update = () => setTheme(currentTheme());
    window.addEventListener("concentrate:theme", update);
    return () => window.removeEventListener("concentrate:theme", update);
  }, []);
  const toggle = () => {
    const next: Theme = currentTheme() === "dark" ? "light" : "dark";
    try { localStorage.setItem(KEY, next); } catch { /* storage unavailable */ }
    apply(next);
  };
  return [theme, toggle];
}

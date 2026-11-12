import { useEffect, useState } from "preact/hooks";

export type Command = {
  id: string;
  title: string;
  /** Section in the palette: "Go to", "Graph", "Project", "Help". */
  group: string;
  /** Extra words that find the command. */
  keywords?: string;
  /** Shown beside the title, for example "F" or "Ctrl+K". */
  shortcut?: string;
  /** Set when the command cannot run now; the palette shows it dimmed with this reason. */
  disabledReason?: string;
  run: () => void;
};

const providers = new Map<string, Command[]>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

/** Screens say what they can do; the palette lists what is registered right now. */
export function useRegisterCommands(owner: string, commands: Command[]): void {
  useEffect(() => {
    providers.set(owner, commands);
    notify();
    return () => { providers.delete(owner); notify(); };
  }, [commands]);
}

export function allCommands(): Command[] {
  return [...providers.values()].flat();
}

export function useCommandList(): Command[] {
  const [, tick] = useState(0);
  useEffect(() => {
    const listener = () => tick((n) => n + 1);
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  }, []);
  return allCommands();
}

/** How well a command matches what was typed: higher is better, null is no match. */
export function scoreCommand(command: Pick<Command, "title" | "keywords">, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return 0;
  const title = command.title.toLowerCase();
  if (title === q) return 5;
  if (title.startsWith(q)) return 4;
  const at = title.indexOf(q);
  if (at >= 0) return title[at - 1] === " " ? 3.5 : 3;
  if ((command.keywords ?? "").toLowerCase().includes(q)) return 2;
  // every typed word appears somewhere
  const words = q.split(/\s+/);
  const haystack = `${title} ${command.keywords ?? ""}`.toLowerCase();
  if (words.length > 1 && words.every((w) => haystack.includes(w))) return 1.5;
  // the letters appear in order ("rtg" finds "Routes to graph")
  let i = 0;
  for (const ch of title) if (ch === q[i]) i++;
  return i === q.length ? 1 : null;
}

export function rankCommands(commands: Command[], query: string): Command[] {
  const order = new Map<string, number>();
  for (const c of commands) if (!order.has(c.group)) order.set(c.group, order.size);
  return commands
    .map((command) => ({ command, score: scoreCommand(command, query) }))
    .filter((entry): entry is { command: Command; score: number } => entry.score !== null)
    .sort((a, b) => b.score - a.score || order.get(a.command.group)! - order.get(b.command.group)! || a.command.title.localeCompare(b.command.title))
    .map((entry) => entry.command);
}

/** "⌘" on a Mac, "Ctrl" elsewhere. */
export const modifierKey = (): string => (typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl");

export function timeAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (seconds < 45) return "just now";
  const steps: Array<[number, number, string]> = [
    [3600, 60, "minute"], [86400, 3600, "hour"], [604800, 86400, "day"], [2592000, 604800, "week"], [31536000, 2592000, "month"], [Infinity, 31536000, "year"],
  ];
  const [, size, unit] = steps.find(([limit]) => seconds < limit)!;
  const n = Math.max(1, Math.round(seconds / size));
  return `${n} ${unit}${n === 1 ? "" : "s"} ago`;
}

export const number = (n: number | null | undefined): string => (n === null || n === undefined ? "-" : n.toLocaleString("en-US"));

export function baseName(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  return trimmed.slice(Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\")) + 1) || trimmed || path;
}

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

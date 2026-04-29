export function formatProperties(properties: Record<string, unknown>): string {
  const entries = Object.entries(properties);
  if (entries.length === 0) {
    return "{}";
  }

  return `{${entries.map(([key, value]) => `${key}: ${formatValue(value)}`).join(", ")}}`;
}

export function quote(value: string): string {
  return JSON.stringify(value);
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  return quote(String(value));
}

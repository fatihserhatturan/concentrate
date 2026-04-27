export function format(value: string): string {
  return `[A] ${value}`;
}

export function parse(value: string): number {
  return parseInt(value, 10);
}

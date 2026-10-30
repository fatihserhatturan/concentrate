export function formatPrice(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// `<T>value` is a type assertion in a .ts file; the same text is JSX in .tsx.
export function asNumber(value: unknown): number {
  return <number>value;
}

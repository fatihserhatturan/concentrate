export function addToCart(id: string): number {
  return id.length;
}

export function formatTotal(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

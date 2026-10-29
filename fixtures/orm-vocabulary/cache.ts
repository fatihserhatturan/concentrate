const cache = new Map<string, number>();

export function resetCache() {
  cache.clear();
  return cache.has('x');
}

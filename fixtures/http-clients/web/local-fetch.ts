// A local fetch, not the global one: no HTTP call.
function fetch(path: string) {
  return path.length;
}

export function size() {
  return fetch('/api/users');
}

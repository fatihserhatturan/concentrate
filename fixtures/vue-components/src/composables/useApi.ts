export function useApi() {
  return { get: (url: string) => fetch(url) };
}

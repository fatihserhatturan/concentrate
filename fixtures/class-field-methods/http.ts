export function send(path: string, token: string | null) {
  return fetch(path, { headers: token ? { authorization: token } : {} });
}

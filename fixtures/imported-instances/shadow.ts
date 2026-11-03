import { api } from "./index";

export function withApi(api: { get(path: string): unknown }) {
  return api.get("/profile");
}

export function logout() {
  api.setToken(null);
}

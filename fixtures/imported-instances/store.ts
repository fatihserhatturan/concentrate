import { api } from "./index";

export function login(token: string) {
  api.setToken(token);
  return api.users();
}

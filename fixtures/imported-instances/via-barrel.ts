import { api as client } from "./barrel";

export function load() {
  return client.get("/articles");
}

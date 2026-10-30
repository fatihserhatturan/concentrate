import { loadPost } from "../api";

export function PostView() {
  loadPost("1");
  return <article />;
}

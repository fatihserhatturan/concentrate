export function loadPost(id: string) {
  return fetch(`${process.env.API_URL}/posts/${id}`);
}

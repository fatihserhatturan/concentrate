export async function load({ fetch }) {
  const response = await fetch('/api/posts');
  return { posts: await response.json() };
}

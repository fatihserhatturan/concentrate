import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ fetch }) => {
  const response = await fetch('/api/posts');
  return { posts: await response.json() };
};

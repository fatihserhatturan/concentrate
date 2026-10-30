import { useQuery } from '@tanstack/react-query';
import { api, client, useTRPC } from '~/trpc/react';

export function Posts() {
  const posts = api.post.all.useQuery();
  const create = api.post.create.useMutation();
  const comments = api.post.comments.list.useQuery();
  const utils = api.useUtils();
  utils.post.byId.fetch({ id: '1' });
  // Cache helpers are not requests.
  utils.post.all.invalidate();
  return [posts, create, comments];
}

export function Me() {
  const trpc = useTRPC();
  return useQuery(trpc.user.me.queryOptions());
}

export async function health() {
  await client.post.create.mutate('x');
  return client.health.query();
}

// A procedure type mismatch and an unknown path: no link.
export function wrong() {
  api.post.all.useMutation();
  return api.post.missing.useQuery();
}

// Not a tRPC client.
const local = { post: { all: { query: () => [] } } };
export const fromLocal = local.post.all.query();

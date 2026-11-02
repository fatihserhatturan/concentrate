import { error } from '@sveltejs/kit';
import { getPost } from '$lib/server/db';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
  const post = getPost(params.slug);
  if (!post) error(404, 'Not found');
  return { post };
};

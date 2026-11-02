import { json } from '@sveltejs/kit';
import { createPost, listPosts } from '$lib/server/db';
import type { RequestHandler } from './$types';

export async function GET() {
  return json(listPosts());
}

export const POST: RequestHandler = async ({ request }) => {
  const { title } = await request.json();
  return json(createPost(title), { status: 201 });
};

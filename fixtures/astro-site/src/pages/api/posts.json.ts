import type { APIRoute } from 'astro';
import { listPosts, savePost } from '../../lib/posts';

export const GET: APIRoute = () => new Response(JSON.stringify(listPosts()));

export async function POST({ request }: { request: Request }) {
  const post = await request.json();
  return new Response(JSON.stringify(savePost(post)), { status: 201 });
}

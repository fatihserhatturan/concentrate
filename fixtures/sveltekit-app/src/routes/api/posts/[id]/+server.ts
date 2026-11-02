import { json } from '@sveltejs/kit';
import { deletePost, getPost } from '$lib/server/db';

export function GET({ params }) {
  return json(getPost(params.id));
}

export function DELETE({ params }) {
  return json(deletePost(params.id));
}

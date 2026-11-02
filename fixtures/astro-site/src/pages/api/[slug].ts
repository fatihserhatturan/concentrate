import { findPost } from '../../lib/posts';

export function ALL({ params }: { params: { slug: string } }) {
  return new Response(JSON.stringify(findPost(params.slug)));
}

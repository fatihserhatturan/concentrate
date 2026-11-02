const posts = new Map<string, { slug: string; title: string }>();

export function listPosts() {
  return [...posts.values()];
}

export function getPost(slug: string) {
  return posts.get(slug) ?? null;
}

export function createPost(title: string) {
  const post = { slug: title.toLowerCase(), title };
  posts.set(post.slug, post);
  return post;
}

export function deletePost(slug: string) {
  return posts.delete(slug);
}

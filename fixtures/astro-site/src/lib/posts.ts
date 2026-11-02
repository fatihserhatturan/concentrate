export type Post = { slug: string; title: string };

const posts: Post[] = [{ slug: 'hello', title: 'Hello' }];

export function listPosts() {
  return posts;
}

export function findPost(slug: string) {
  return posts.find((post) => post.slug === slug) ?? null;
}

export function savePost(post: Post) {
  posts.push(post);
  return post;
}

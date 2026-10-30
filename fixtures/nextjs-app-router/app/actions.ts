'use server';

// A module of server actions: every export is one.
const posts: string[] = [];

function normalize(title: string) {
  return title.trim();
}

export async function createPost(formData: FormData) {
  posts.push(normalize(String(formData.get('title'))));
}

export const deletePost = async (index: number) => {
  posts.splice(index, 1);
};

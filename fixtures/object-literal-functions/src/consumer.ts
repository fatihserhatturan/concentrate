import ArticleAPI, { TagAPI } from './api';

export async function load(slug: string) {
  // Handlers stay inline: objects built in a function have no Function nodes.
  const handlers = { onLoad: () => ArticleAPI.get(slug) };
  [1, 2].map((n) => n * 2);
  await TagAPI.getAll();
  return handlers;
}

import axios from 'axios';
import { ORIGIN } from './origin';

const API = import.meta.env.VITE_API_URL;
const api = axios.create({ baseURL: import.meta.env.VITE_API_URL });

// .env.development wins over .env.example: /api/posts.
export function posts() {
  return fetch(`${API}/posts`);
}

export function post(id: string) {
  return api.get(`/posts/${id}`);
}

// A literal fallback, through an imported template constant.
export function createPost() {
  return fetch(`${ORIGIN}/posts`, { method: 'POST' });
}

export function inline() {
  return fetch(`${process.env.API_ORIGIN || 'http://127.0.0.1:4000'}/api/posts`);
}

// An external origin and an env var with no value: unlinked, kept as written.
export function remote() {
  return fetch(`${process.env.NEXT_PUBLIC_REMOTE}/posts`);
}

export function missing() {
  return fetch(`${process.env.NOT_SET}/api/posts`);
}

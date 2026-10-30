import axios from 'axios';
import ky from 'ky';
import { ofetch } from 'ofetch';

export async function loadUsers() {
  return fetch('/api/users');
}

export async function loadUser(id: string) {
  return fetch(`/api/users/${id}`);
}

export async function loadMe() {
  return fetch('/api/users/me');
}

export async function createUser(body: string) {
  return fetch('/api/users', { method: 'POST', body });
}

export async function removeUser(id: string) {
  return window.fetch(`/api/users/${id}?hard=1`, { method: 'delete' });
}

export async function updateUser(id: string) {
  return axios.patch(`/api/users/${id}`, { name: 'x' });
}

export async function addUser() {
  return axios({ url: '/api/users', method: 'post' });
}

export async function download() {
  return axios.request({ url: '/files/reports/2024.csv' });
}

export async function kyUsers() {
  return ky.get('/api/users').json();
}

export async function kyCreate() {
  return ky('/api/users', { method: 'post' });
}

export async function ofetchMe() {
  return ofetch('/api/users/me');
}

export async function nuxtCreate() {
  return $fetch('/api/users', { method: 'POST' });
}

// Not linked: unknown options, a dynamic URL, a partly dynamic segment, an
// absolute URL, and two equally specific routes.
export async function unlinked(options: RequestInit, url: string, id: string) {
  await fetch('/api/users', options);
  await fetch(url);
  await fetch(`/api/users/${id}.json`);
  await fetch('https://example.com/api/users');
  await axios.get(`/api/items/${id}`);
}

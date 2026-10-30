import client, { api, local, remote, kyApi } from './client';
import { USERS } from './constants';

const express = require('express');
const router = express.Router();

export async function user(id: string) {
  return api.get(`/users/${id}`);
}

export async function addUser() {
  return api.request({ url: 'users', method: 'POST' });
}

export async function me() {
  return local.get('/users/me');
}

export async function patchUser(id: string) {
  return client.patch(`users/${id}`);
}

export async function kyUsers() {
  return kyApi.get('users');
}

export async function constantUsers() {
  return fetch(USERS);
}

export async function remoteUsers() {
  // An external base: stays unlinked.
  return remote.get('/users');
}

export function dynamic(url: string) {
  // A parameter, not a constant: stays unlinked.
  return fetch(url);
}

// An Express router is not an HTTP client.
router.get('/internal/health', () => null);

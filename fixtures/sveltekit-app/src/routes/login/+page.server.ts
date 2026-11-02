import { redirect } from '@sveltejs/kit';
import { login, logout } from '$lib/server/session';
import type { Actions } from './$types';

export const actions = {
  default: async ({ request }) => {
    const data = await request.formData();
    login(String(data.get('email')));
    redirect(303, '/');
  },
  logout: async ({ cookies }) => {
    logout(cookies.get('token') ?? '');
  },
} satisfies Actions;

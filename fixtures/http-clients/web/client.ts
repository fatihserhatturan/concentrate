import axios from 'axios';
import ky from 'ky';
import { ofetch } from 'ofetch';
import { API, API_ORIGIN, REMOTE } from './constants';

export const api = axios.create({ baseURL: API });
export const local = axios.create({ baseURL: `${API_ORIGIN}/api` });
export const remote = axios.create({ baseURL: REMOTE });
export const kyApi = ky.create({ prefixUrl: '/api' });
const nuxtApi = ofetch.create({ baseURL: '/api' });

export async function listUsers() {
  return api.get('/users');
}

export async function nuxtUser(id: string) {
  return nuxtApi(`/users/${id}`);
}

export default axios.create({ baseURL: 'http://127.0.0.1:4000/api/' });

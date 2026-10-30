import axios from 'axios';
import { request } from './http';

const ArticleAPI = {
  all: () => axios.get('/api/articles'),
  get: (slug: string) => axios.get(`/api/articles/${slug}`),
  async create(body: unknown) {
    return axios.post('/api/articles', body);
  },
  comments: {
    list: function (slug: string) {
      return request(`/api/articles/${slug}/comments`);
    },
  },
} as const;

export default ArticleAPI;

export const TagAPI = {
  getAll: () => axios.get('/api/tags'),
};

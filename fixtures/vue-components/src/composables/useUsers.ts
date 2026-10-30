import { ref } from 'vue';
import { useApi } from './useApi';

export function useUsers() {
  const users = ref([]);
  const api = useApi();
  const load = () => api.get('/users');
  return { users, load };
}

import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import { useCartStore } from './cart';

export const useUserStore = defineStore('user', () => {
  const name = ref('');
  const loggedIn = computed(() => name.value !== '');
  function login(value: string) {
    name.value = value;
  }
  const logout = () => {
    name.value = '';
    useCartStore().clear();
  };
  return { name, loggedIn, login, logout };
});

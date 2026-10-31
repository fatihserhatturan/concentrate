import { defineStore } from 'pinia';
import { saveCart } from '../composables/storage';

export const useCartStore = defineStore('cart', {
  state: () => ({ items: [] as string[], coupon: null as string | null }),
  getters: {
    count: (state) => state.items.length,
    hasCoupon(state) {
      return state.coupon !== null;
    },
  },
  actions: {
    add(item: string) {
      this.items.push(item);
      saveCart(this.items);
    },
    clear() {
      this.$reset();
    },
  },
});

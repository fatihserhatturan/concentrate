import { useCartStore } from '../stores';

// Module-level use has no function: no edge.
const shared = useCartStore();

export function useCheckout() {
  const cart = useCartStore();
  function applyCoupon(code: string) {
    cart.$patch({ coupon: code });
  }
  const total = () => cart.count * 10;
  return { applyCoupon, total, shared };
}

// Not a store: a local hook with a store-like name.
function useStore() {
  return { items: [] };
}

export function useLocal() {
  const local = useStore();
  return local.items;
}

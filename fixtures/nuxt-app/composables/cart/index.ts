export function useCartTotal() {
  const { items } = useCart();
  return computed(() => items.value.length * 10);
}

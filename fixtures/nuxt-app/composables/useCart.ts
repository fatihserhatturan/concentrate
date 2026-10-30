export function useCart() {
  const items = useState('cart', () => []);
  const count = computed(() => items.value.length);
  return { items, count };
}

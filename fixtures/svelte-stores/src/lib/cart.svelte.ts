export const cart = $state({ items: [] as string[], coupon: null as string | null });

export function addItem(item: string) {
  cart.items.push(item);
}

export function itemCount() {
  return cart.items.length;
}

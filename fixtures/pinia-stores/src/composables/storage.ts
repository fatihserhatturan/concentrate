export function saveCart(items: string[]) {
  localStorage.setItem('cart', JSON.stringify(items));
}

import { useContext, useMemo } from 'react';
import { CartContext } from './CartContext';

export function useCart() {
  const cart = useContext(CartContext);
  if (!cart) throw new Error('useCart needs a CartProvider');
  return cart;
}

export function useCartCount() {
  const cart = useCart();
  return useMemo(() => cart.items.length, [cart.items]);
}

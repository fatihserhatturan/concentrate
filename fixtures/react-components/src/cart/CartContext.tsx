import { createContext, useState, type ReactNode } from 'react';

export type Cart = { items: string[]; add: (item: string) => void };

export const CartContext = createContext<Cart | null>(null);

export function CartProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<string[]>([]);
  const add = (item: string) => setItems([...items, item]);
  return <CartContext.Provider value={{ items, add }}>{children}</CartContext.Provider>;
}

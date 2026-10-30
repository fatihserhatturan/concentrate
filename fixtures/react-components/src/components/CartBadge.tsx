import { useEffect } from 'react';
import { useCartCount } from '../cart/useCart';

export function CartBadge() {
  const count = useCartCount();
  useEffect(() => {
    document.title = `Cart (${count})`;
  }, [count]);
  return <span className="badge">{count}</span>;
}

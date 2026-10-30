import type { ReactNode } from 'react';

export default function ShopTemplate({ children }: { children: ReactNode }) {
  return <div className="shop">{children}</div>;
}

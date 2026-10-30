import type { ReactNode } from 'react';

export function Layout({ children }: { children: ReactNode }) {
  return <main className="layout">{children}</main>;
}

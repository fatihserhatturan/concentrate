import { memo, type ReactNode } from 'react';
import { Button } from './Button';

export const Card = memo(function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
      <Button label="More" />
    </section>
  );
});

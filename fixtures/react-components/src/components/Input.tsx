import { forwardRef } from 'react';

export const Input = forwardRef<HTMLInputElement, { name: string }>((props, ref) => (
  <input ref={ref} name={props.name} />
));

'use client';

export default function BlogError({ reset }: { reset: () => void }) {
  return <button onClick={reset}>Try again</button>;
}

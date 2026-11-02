import { derived, readable, writable } from 'svelte/store';

export const count = writable(0);

export const time = readable(new Date(), (set) => {
  const interval = setInterval(() => set(new Date()), 1000);
  return () => clearInterval(interval);
});

export const doubled = derived(count, ($count) => $count * 2);

function createCounter() {
  const { subscribe, set, update } = writable(0);

  function reset() {
    set(0);
  }

  return {
    subscribe,
    increment: () => update((n) => n + 1),
    reset,
  };
}

export const counter = createCounter();

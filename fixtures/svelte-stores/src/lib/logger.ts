import { get } from 'svelte/store';
import { count, time } from './stores';
import { cart } from './cart.svelte.js';

export function logCount() {
  console.log(get(count));
}

export function logCart() {
  console.log(cart.items);
}

export function watchTime(onTick: (value: Date) => void) {
  return time.subscribe(onTick);
}

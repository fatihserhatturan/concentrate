import { items } from './data';

// `items` is a Map, not a store: `set` here is no store write.
export function register(key: string) {
  items.set(key, true);
}

import { atom } from 'jotai';
import { atomWithStorage } from 'jotai/utils';

export const countAtom = atom(0);

export const settingsAtom = atomWithStorage('settings', { theme: 'light', compact: false });

export const doubledAtom = atom((get) => get(countAtom) * 2);

export const incrementAtom = atom(null, (get, set, by: number) => {
  set(countAtom, get(countAtom) + by);
});

export const resetAtom = atom(
  (get) => get(countAtom) === 0,
  (_get, set) => {
    set(countAtom, 0);
  },
);

const userAtom = atom({ name: '', admin: false });

export default userAtom;

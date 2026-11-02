import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

type BearState = {
  bears: number;
  honey: string[];
  increase: (by: number) => void;
  reset: () => void;
};

function log(message: string) {
  console.log(message);
}

export const useBearStore = create<BearState>()(
  devtools(
    persist(
      (set) => ({
        bears: 0,
        honey: [],
        increase: (by) => {
          log('increase');
          set((state) => ({ bears: state.bears + by }));
        },
        reset() {
          log('reset');
          set({ bears: 0 });
        },
      }),
      { name: 'bears' },
    ),
  ),
);

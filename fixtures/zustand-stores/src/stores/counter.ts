import { create } from 'zustand';
import { combine } from 'zustand/middleware';

const useCounterStore = create(
  combine({ count: 0 }, (set) => ({
    inc: () => set((state) => ({ count: state.count + 1 })),
  })),
);

export default useCounterStore;

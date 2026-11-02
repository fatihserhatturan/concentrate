import { createStore } from 'zustand/vanilla';

export const settingsStore = createStore(() => ({
  theme: 'light',
}));

export const themeStore = createStore((set) => ({
  theme: 'light',
  toggle: () => set((state) => ({ theme: state.theme === 'light' ? 'dark' : 'light' })),
}));

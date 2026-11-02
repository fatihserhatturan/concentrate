import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { RootState } from '../../app/store';

type Item = { id: string; price: number };

const initialState = {
  items: [] as Item[],
  total: 0,
};

function recalculate(state: typeof initialState) {
  state.total = state.items.reduce((sum, item) => sum + item.price, 0);
}

export const cartSlice = createSlice({
  name: 'cart',
  initialState,
  reducers: {
    addItem(state, action: PayloadAction<Item>) {
      state.items.push(action.payload);
      recalculate(state);
    },
    removeItem: (state, action: PayloadAction<string>) => {
      state.items = state.items.filter((item) => item.id !== action.payload);
      recalculate(state);
    },
    clear: {
      reducer(state) {
        state.items = [];
        recalculate(state);
      },
      prepare() {
        return { payload: undefined };
      },
    },
  },
});

export const { addItem, removeItem, clear } = cartSlice.actions;

export const selectItems = (state: RootState) => state.cart.items;

export default cartSlice.reducer;

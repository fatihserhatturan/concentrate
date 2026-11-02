import { combineReducers, configureStore, createSlice } from '@reduxjs/toolkit';
import cartReducer from '../features/cart/cartSlice';
import { userReducer } from '../features/user/userSlice';

const sessionSlice = createSlice({
  name: 'session',
  initialState: { token: null as string | null },
  reducers: {
    setToken: (state, action) => {
      state.token = action.payload;
    },
  },
});

export const { setToken } = sessionSlice.actions;

const rootReducer = combineReducers({
  cart: cartReducer,
  user: userReducer,
  auth: sessionSlice.reducer,
});

export const store = configureStore({ reducer: rootReducer });

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

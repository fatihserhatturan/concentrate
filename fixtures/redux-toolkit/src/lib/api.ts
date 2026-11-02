// A createSlice that is not Redux Toolkit's: no store.
import { createSlice } from './slices';

export const fetchProfile = () => async () => fetch('/api/profile');

export const fake = createSlice({ name: 'fake', initialState: {}, reducers: {} });

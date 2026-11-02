import { createSlice } from '@reduxjs/toolkit';

export const userSlice = createSlice({
  name: 'user',
  initialState: { name: '', loggedIn: false },
  reducers: {
    login: (state, action) => {
      state.name = action.payload;
      state.loggedIn = true;
    },
    logout: (state) => {
      state.loggedIn = false;
    },
  },
  selectors: {
    selectName: (state) => state.name,
  },
});

export const userReducer = userSlice.reducer;

import { useDispatch, useSelector } from 'react-redux';
import { setToken } from '../app/store';
import { userSlice } from '../features/user/userSlice';
import { fetchProfile } from '../lib/api';

export function Profile() {
  const name = useSelector(({ user }) => user.name);
  const token = useSelector((state: any) => state.auth.token);
  // Not a key of the store: no read.
  const theme = useSelector((state: any) => state.theme.mode);
  const dispatch = useDispatch();

  function signOut() {
    dispatch(userSlice.actions.logout());
    dispatch(setToken(null));
    // A thunk, not a slice action: no write.
    dispatch(fetchProfile());
  }

  return <button onClick={signOut}>{name} {token} {theme}</button>;
}

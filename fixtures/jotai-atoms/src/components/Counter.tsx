import { useAtom, useAtomValue, useSetAtom } from 'jotai';
import userAtom, { countAtom, doubledAtom, incrementAtom, settingsAtom } from '../atoms/counter';

export function Counter() {
  const [count] = useAtom(countAtom);
  const doubled = useAtomValue(doubledAtom);
  const increment = useSetAtom(incrementAtom);
  return <button onClick={() => increment(1)}>{count} {doubled}</button>;
}

export function Settings() {
  const [settings, setSettings] = useAtom(settingsAtom);
  const user = useAtomValue(userAtom);
  return <button onClick={() => setSettings({ ...settings, compact: true })}>{user.name}</button>;
}

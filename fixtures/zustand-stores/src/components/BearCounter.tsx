import { useShallow } from 'zustand/react/shallow';
import { useBearStore } from '../stores/bears';
import useCounterStore from '../stores/counter';

export function BearCounter() {
  const bears = useBearStore((state) => state.bears);
  const increase = useBearStore((state) => state.increase);
  const { honey, reset } = useBearStore(useShallow(({ honey, reset }) => ({ honey, reset })));
  const count = useCounterStore((state) => state.count);
  return (
    <button onClick={() => increase(1)} onDoubleClick={reset}>
      {bears} {honey.length} {count}
    </button>
  );
}

export function Controls() {
  const { inc } = useCounterStore();
  return <button onClick={inc}>+</button>;
}

export function resetAll() {
  useBearStore.getState().reset();
  useBearStore.setState({ honey: [] });
}

export function bearCount() {
  return useBearStore.getState().bears;
}

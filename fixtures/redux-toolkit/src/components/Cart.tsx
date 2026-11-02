import { useSelector } from 'react-redux';
import { useAppDispatch, useAppSelector } from '../app/hooks';
import type { RootState } from '../app/store';
import { addItem, removeItem, selectItems } from '../features/cart/cartSlice';

export function Cart() {
  const items = useAppSelector(selectItems);
  const total = useSelector((state: RootState) => state.cart.total);
  const dispatch = useAppDispatch();

  function add() {
    dispatch(addItem({ id: String(items.length), price: 1 }));
  }

  return (
    <div>
      <span>{total}</span>
      <button onClick={add}>Add</button>
      {items.map((item) => (
        <button key={item.id} onClick={() => dispatch(removeItem(item.id))}>Remove</button>
      ))}
    </div>
  );
}

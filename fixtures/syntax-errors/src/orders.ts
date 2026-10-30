import { save } from './store';

export function createOrder(total: number) {
  // A half-typed statement: only this statement is left out.
  const discount = ;
  return save({ total });
}

export class OrderService {
  list() {
    return save({ total: 0 });
  }

  // A broken member: the class and its other methods stay.
  cancel( {
  }
}

// A declaration cut off at the end of the file.
export function refund(id: string

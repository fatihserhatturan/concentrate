import * as MathUtils from './utils.js';
import { add } from './utils.js';

function helper(): number {
  return 42;
}

export function run(): number {
  const x = helper();
  const y = MathUtils.multiply(2, 3);
  const z = add(1, 2);
  return x + y + z;
}

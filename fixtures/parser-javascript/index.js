import { helper } from "./utils.js";

export function greet(name) {
  return helper(name);
}

export const add = (a, b) => a + b;

export const compute = async function (x) {
  return helper(x);
};

const _internal = () => {};

export class Calculator {
  sum(a, b) {
    return a + b;
  }

  async fetchResult(id) {
    return helper(id);
  }
}

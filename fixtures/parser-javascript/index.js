import { helper } from "./utils.js";

export const MAX_SIZE = 100;
export let defaultName = 'World';
var globalFlag = false;

export function greet(name) {
  return helper(name);
}

export const add = (a, b) => a + b;

export const compute = async function (x) {
  return helper(x);
};

const _internal = () => {};

export class Calculator {
  get result() {
    return helper('result');
  }

  set result(value) {
    helper(value);
  }

  sum(a, b) {
    return a + b;
  }

  async fetchResult(id) {
    return helper(id);
  }
}

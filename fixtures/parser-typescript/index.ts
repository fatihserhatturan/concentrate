import { helper } from "./utils.js";

export function greet(name: string): string {
  return helper(name);
}

export const add = (a: number, b: number): number => a + b;

export const fetchData = async (url: string): Promise<string> => {
  return helper(url);
};

const _internal = (): void => {};

export class UserService {
  getName(id: string): string {
    return helper(id);
  }

  async fetchUser(id: string): Promise<string> {
    return helper(id);
  }
}

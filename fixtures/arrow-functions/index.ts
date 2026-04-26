export const greet = (name: string): string => {
  return String(name);
};

export const fetchData = async (url: string) => {
  return JSON.parse(url);
};

const multiply = function(a: number, b: number): number {
  return a * b;
};

export function outer(): void {
  const inner = () => {
    String(42);
  };
  inner();
}

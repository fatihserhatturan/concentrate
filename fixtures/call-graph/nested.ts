declare function setup(): void;
declare function finish(): void;
declare function nestedOnly(): void;

export function outer(): void {
  setup();

  function inner(): void {
    nestedOnly();
  }

  finish();
}

<script lang="ts">
  import { count, doubled, counter } from './lib';
  import { cart, addItem } from './lib/cart.svelte';
  import { logCount } from './lib/logger';
  import Clock from './Clock.svelte';

  function bump() {
    $count += 1;
    logCount();
  }

  function reset() {
    count.set(0);
  }

  function coupon(code: string) {
    cart.coupon = code;
  }
</script>

<p>{$count} × 2 = {$doubled}</p>
<input type="number" bind:value={$count} />
<button onclick={bump}>+</button>
<button onclick={reset}>reset</button>
<button onclick={counter.increment}>{$counter}</button>
<button onclick={() => counter.reset()}>zero</button>
<button onclick={() => addItem('apple')}>{cart.items.length} items</button>
<button onclick={() => coupon('SAVE')}>coupon</button>
<Clock />

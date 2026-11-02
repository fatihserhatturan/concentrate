<script context="module">
  export const label = 'counter';
</script>

<script>
  import { track } from '../api';

  export let start = 0;
  let count = start;

  function increment() {
    count += 1;
    track('counter:increment');
  }
</script>

<button on:click={increment}>{label}: {count}</button>
<button on:click={() => count--}>-</button>

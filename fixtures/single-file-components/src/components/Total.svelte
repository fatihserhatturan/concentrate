<script context="module" lang="ts">
  export const currency = 'USD';
</script>

<script lang="ts">
  import { formatTotal } from '../lib/cart';

  export let cents: number;
  $: label = formatTotal(cents);

  function refresh() {
    return formatTotal(cents + 1);
  }
</script>

{#if cents > 0}
  <p on:click={refresh}>{label} {currency}</p>
{:else}
  <p>Empty</p>
{/if}

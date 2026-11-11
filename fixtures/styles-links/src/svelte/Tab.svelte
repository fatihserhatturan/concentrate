<script>
  export let selected = false;
  let kind = "x";
</script>

<button class="tab {kind} big" class:selected class:disabled={!selected} class="tab-{kind}">Tab</button>

<style>
  .tab { padding: 2px; }
  .selected { font-weight: bold; }
  :global(.big) { font-size: 2em; }
</style>

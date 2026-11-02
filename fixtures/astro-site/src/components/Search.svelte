<script>
  let { placeholder = 'Search' } = $props();
  let query = $state('');
</script>

<input {placeholder} bind:value={query} />

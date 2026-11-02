<script>
  let { variant = 'solid', onclick, children } = $props();
</script>

<button class={variant} {onclick}>{@render children?.()}</button>

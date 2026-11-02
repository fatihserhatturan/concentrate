<script lang="ts">
  let { data, children } = $props();
</script>

<nav>{data.user?.email}</nav>
{@render children()}

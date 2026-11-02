<script lang="ts">
  import PostCard from '$lib/components/PostCard.svelte';

  let { data } = $props();
</script>

{#each data.posts as post}
  <PostCard {post} />
{/each}

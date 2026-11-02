<script lang="ts">
  async function remove(id: string) {
    await fetch(`/api/posts/${id}`, { method: 'DELETE' });
  }
</script>

<button onclick={() => remove('1')}>Delete</button>

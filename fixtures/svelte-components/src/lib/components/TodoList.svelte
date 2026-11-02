<script lang="ts">
  import TodoItem from './TodoItem.svelte';

  let { todos, filter = $bindable('all'), onremove, ...rest } = $props();

  let visible = $derived(todos.filter((todo) => filter === 'all' || todo.done === (filter === 'done')));

  function select(value: string) {
    filter = value;
  }
</script>

<ul {...rest}>
  {#each visible as todo (todo.id)}
    <TodoItem {todo} on:toggle remove={() => onremove(todo.id)} />
  {/each}
</ul>
<button onclick={() => select('all')}>All</button>
<button onclick={() => select('done')}>Done</button>

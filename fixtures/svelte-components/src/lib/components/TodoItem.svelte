<script>
  import { createEventDispatcher } from 'svelte';
  import { saveTodo } from '../api';

  export let todo;
  export let remove = () => {};
  export const kind = 'todo';

  const dispatch = createEventDispatcher();

  async function save() {
    await saveTodo(todo.title);
    dispatch('toggle', todo.id);
  }
</script>

<li class:done={todo.done}>
  <input type="checkbox" bind:checked={todo.done} on:change={save} />
  <span on:dblclick|preventDefault|stopPropagation={save}>{todo.title}</span>
  <button on:click={remove}>×</button>
  <button on:click>forward</button>
</li>

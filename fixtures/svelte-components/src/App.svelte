<script lang="ts">
  import TodoList from './lib/components/TodoList.svelte';
  import Counter from './lib/components/Counter.svelte';
  import Footer from './lib/components/Footer.svelte';
  import * as Ui from './lib/ui/index.ts';
  import { track } from './lib/api';

  let todos = $state([{ id: 1, title: 'Write docs', done: false }]);
  let filter = $state('all');
  let view = $derived(filter === 'all' ? TodoList : Counter);

  track('app:start');

  function clearDone() {
    todos = todos.filter((todo) => !todo.done);
  }
</script>

<main class="app {filter}">
  <TodoList {todos} bind:filter onremove={(id) => (todos = todos.filter((t) => t.id !== id))} />
  <Counter start={todos.length} />
  <Ui.Button variant="ghost" onclick={() => clearDone()}>Clear</Ui.Button>
  <svelte:component this={view} {todos} />
  {#if todos.length > 0}
    <button onclick={() => {
      clearDone();
    }}>Clear done</button>
  {/if}
  <Footer />
</main>

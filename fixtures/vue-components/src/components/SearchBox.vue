<template>
  <input :value="term" @keyup.enter="submit" />
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';
import { useUsers } from '../composables/useUsers';

export default defineComponent({
  setup() {
    const term = ref('');
    const { load } = useUsers();
    const submit = () => load();
    return { term, submit };
  },
});
</script>

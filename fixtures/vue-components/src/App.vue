<template>
  <main>
    <UserCard :user="current" title="Me" @click="select" v-if="current" />
    <user-list v-model="users" v-bind:filter="query">
      <template #empty><TagChip label="none" /></template>
    </user-list>
    <component :is="view" />
    <RouterView />
    <my-widget></my-widget>
    <slot name="footer" />
    <button type="button" @click="select">Pick</button>
    <form @submit.prevent="save($event)">
      <input v-on:keyup.enter="save" @input="query = $event.target.value" />
    </form>
    <SearchBox />
  </main>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import UserCard from './components/UserCard.vue';
import UserList from './components/UserList.vue';
import TagChip from './components/Tag.vue';
import SearchBox from './components/SearchBox.vue';
import { useUsers } from './composables/useUsers';

defineProps<{ title: string; query?: string }>();
const current = ref(null);
const { users, load } = useUsers();
const view = ref('div');
onMounted(() => load());
function select() {}
function save(event?: Event) {
  console.log(event);
}
</script>

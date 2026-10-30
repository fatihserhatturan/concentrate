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
  </main>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import UserCard from './components/UserCard.vue';
import UserList from './components/UserList.vue';
import TagChip from './components/Tag.vue';

defineProps<{ title: string; query?: string }>();
const current = ref(null);
const users = ref([]);
const view = ref('div');
function select() {}
</script>

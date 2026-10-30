<template>
  <ul><li v-for="user in users" :key="user.id">{{ user.id }}</li></ul>
</template>

<script setup lang="ts">
const { data: users } = await useFetch('/api/users');
async function add() {
  await $fetch('/api/users', { method: 'POST', body: { name: 'Ada' } });
}
</script>

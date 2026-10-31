<template>
  <form @submit.prevent="login(username)">
    <input v-model="username" />
    <span v-if="loggedIn">Welcome</span>
  </form>
</template>

<script setup lang="ts">
import { ref } from 'vue';
import { useUserStore } from '../stores';

const username = ref('');
const { login, loggedIn } = useUserStore();
</script>

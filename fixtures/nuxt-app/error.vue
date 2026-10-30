<template>
  <main>
    <h1>{{ error.statusCode }}</h1>
    <BaseButton @click="clearError({ redirect: '/' })">Home</BaseButton>
  </main>
</template>

<script setup lang="ts">
defineProps<{ error: { statusCode: number } }>();
</script>

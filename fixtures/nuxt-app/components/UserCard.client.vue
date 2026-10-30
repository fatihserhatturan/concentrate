<template>
  <article>{{ name }}</article>
</template>

<script setup lang="ts">
defineProps<{ name: string }>();
</script>

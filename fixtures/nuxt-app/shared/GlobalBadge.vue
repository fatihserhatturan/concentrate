<template>
  <span class="badge">{{ count }}</span>
</template>

<script setup lang="ts">
defineProps<{ count: number }>();
</script>

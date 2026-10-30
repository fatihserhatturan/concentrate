<template>
  <span :style="{ color }">{{ label }}</span>
</template>

<script setup>
defineOptions({ name: 'TagChip' });
defineProps(['label', 'color']);
</script>

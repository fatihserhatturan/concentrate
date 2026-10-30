<template>
  <article>
    <h2>{{ title }}</h2>
    <p>{{ user.name }}</p>
  </article>
</template>

<script setup lang="ts">
interface Props {
  user: { name: string };
  title?: string;
}

const props = withDefaults(defineProps<Props>(), { title: 'User' });
</script>

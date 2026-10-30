<template>
  <LazyUserCard :name="name" />
</template>

<script setup lang="ts">
const route = useRoute();
const { name } = useUser(String(route.params.id));
</script>

<template>
  <LazyUserCard :name="name" />
</template>

<script setup lang="ts">
const route = useRoute();
const { name } = useUser(String(route.params.id));
const { data: user } = await useAsyncData('user', () => $fetch(`/api/users/${route.params.id}`));
const { data: health } = useLazyFetch('/health');
</script>

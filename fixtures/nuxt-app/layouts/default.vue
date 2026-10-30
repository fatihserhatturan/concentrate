<template>
  <div>
    <AppHeader />
    <slot />
    <GlobalBadge :count="count" />
  </div>
</template>

<script setup lang="ts">
const { count } = useCart();
</script>

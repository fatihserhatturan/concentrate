<template>
  <article>{{ title }}</article>
</template>

<script setup lang="ts">
// A local function shadows the auto-imported one.
function formatName(user: { first: string; last: string }) {
  return user.first;
}
const title = formatName({ first: 'Post', last: '' });
</script>

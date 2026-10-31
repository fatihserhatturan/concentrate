<template>
  <span class="badge">{{ count }}</span>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useCartStore } from '../stores/cart';

const { count } = storeToRefs(useCartStore());
</script>

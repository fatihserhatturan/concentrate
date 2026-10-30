<template>
  <button class="cart" @click="add">
    Add {{ label }} <span v-if="count > 0">({{ count }})</span>
  </button>
</template>

<script lang="ts">
export const name = 'CartButton';
</script>

<script setup lang="ts">
import { ref } from 'vue';
import { addToCart } from '../lib/cart';

const props = defineProps<{ id: string; label: string }>();
const count = ref<number>(0);

function add() {
  count.value = addToCart(props.id);
}
</script>

<style scoped>
.cart { color: red; }
</style>

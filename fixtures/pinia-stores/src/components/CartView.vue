<template>
  <ul>
    <li v-for="item in items" :key="item">{{ item }}</li>
  </ul>
  <button @click="addSample">Add</button>
</template>

<script setup lang="ts">
import { storeToRefs } from 'pinia';
import { useCartStore } from '../stores/cart';

const cart = useCartStore();
const { items, count } = storeToRefs(cart);
function addSample() {
  cart.add('sample');
  cart.coupon = null;
}
</script>

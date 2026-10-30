<template>
  <main>
    <h1>Shop</h1>
    <p>{{ total }}</p>
    <BaseButton @click="checkout">Checkout</BaseButton>
  </main>
</template>

<script setup lang="ts">
const total = useCartTotal();
function checkout() {}
</script>

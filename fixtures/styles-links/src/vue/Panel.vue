<script setup lang="ts">
import { ref } from "vue";
const on = ref(false);
</script>

<template>
  <div class="panel wide" :class="{ active: on, 'is-open': on }">
    <h3 :class="$style.header">Title</h3>
    <p :class="[on ? 'on' : 'off', $style['body']]" class="shared">Text</p>
  </div>
</template>

<style module>
.header { font-size: 2em; }
.body { margin: 0; }
</style>

<style scoped>
.panel { padding: 8px; }
.wide { width: 100%; }
</style>

<style lang="scss">
.shared { color: var(--panel-color); &.on { color: red; } }
</style>

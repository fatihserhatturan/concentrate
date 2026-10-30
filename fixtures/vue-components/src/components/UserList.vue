<template>
  <ul>
    <Item v-for="user in modelValue" :key="user.id" :item="user" />
    <li v-if="modelValue.length === 0"><slot name="empty" /></li>
  </ul>
</template>

<script lang="ts">
import { defineComponent } from 'vue';
import ListItem from './ListItem.vue';

export default defineComponent({
  name: 'UserList',
  components: { Item: ListItem },
  props: ['modelValue', 'filter'],
  emits: ['update:modelValue'],
});
</script>

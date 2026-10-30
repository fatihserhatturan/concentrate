<template>
  <li>
    {{ item.name }}
    <badge-icon :count="1" />
  </li>
</template>

<script>
import BadgeIcon from './Badge.vue';
import { useUsers } from '../composables/useUsers';

export default {
  components: { BadgeIcon },
  props: {
    item: { type: Object, required: true },
  },
  setup(props) {
    useUsers();
    return {};
  },
};
</script>

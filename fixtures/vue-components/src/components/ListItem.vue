<template>
  <li>
    {{ item.name }}
    <badge-icon :count="1" />
  </li>
</template>

<script>
import BadgeIcon from './Badge.vue';

export default {
  components: { BadgeIcon },
  props: {
    item: { type: Object, required: true },
  },
  setup(props) {
    return {};
  },
};
</script>

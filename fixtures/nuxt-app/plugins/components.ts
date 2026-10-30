import GlobalBadge from '../shared/GlobalBadge.vue';

export default defineNuxtPlugin((nuxtApp) => {
  nuxtApp.vueApp.component('GlobalBadge', GlobalBadge);
});

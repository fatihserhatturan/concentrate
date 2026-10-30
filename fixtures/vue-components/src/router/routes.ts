import type { RouteRecordRaw } from 'vue-router';
import HomeView from '../views/HomeView.vue';
import SettingsLayout from '../views/SettingsLayout.vue';

export const routes: RouteRecordRaw[] = [
  { path: '/', name: 'home', component: HomeView },
  { path: '/about', component: () => import('../views/AboutView.vue') },
  {
    path: '/settings',
    component: SettingsLayout,
    children: [
      { path: '', components: { default: () => import('../views/SettingsProfile.vue') } },
      { path: 'security', component: () => import('../views/SettingsSecurity.vue') },
    ],
  },
  { path: '/old-home', redirect: '/' },
];

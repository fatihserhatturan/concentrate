import { createRouter, createWebHistory } from 'vue-router';
import { routes } from './routes';
import UserView from '../views/UserView.vue';

// The imported records are spread in: they are pages of routes.ts.
export const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: '/users/:id', component: UserView }, ...routes],
});

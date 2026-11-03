import { createApp } from 'vue';
import App from './App.vue';

// A Vue app: `app[name](…)` installs plugins, not routes.
const app = createApp(App);
for (const name of ['use', 'mount']) app[name]('#app');

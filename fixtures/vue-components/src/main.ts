import { createApp } from 'vue';
import App from './App.vue';
import Badge from './components/Badge.vue';
import { router } from './router';

const app = createApp(App);
// `<my-widget>` in App.vue renders Badge through this registration.
app.component('MyWidget', Badge);
app.use(router);
app.mount('#app');

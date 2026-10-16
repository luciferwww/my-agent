import { createApp } from 'vue';
import 'katex/dist/katex.min.css';

import App from './App.vue';
import { initializeTheme } from './client/theme';
import './style.css';

initializeTheme();
createApp(App).mount('#app');

import { fileURLToPath, URL } from 'node:url';

import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  root: fileURLToPath(new URL('./client', import.meta.url)),
  plugins: [vue()],
  build: {
    outDir: fileURLToPath(new URL('./client/dist', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
  },
});

import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      'my-agent/extension-api': fileURLToPath(new URL('./src/extension/api/index.ts', import.meta.url)),
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'extensions/**/*.test.ts'],
    exclude: [
      'src/**/*.integration.test.ts',
      'src/architecture-fitness/**/*.test.ts',
    ],
    setupFiles: ['./src/test-setup.ts'],
  },
});

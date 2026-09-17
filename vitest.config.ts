import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      'my-agent/extension-api': fileURLToPath(new URL('./src/extension/api/index.ts', import.meta.url)),
    },
  },
  test: {
    setupFiles: ['./src/test-setup.ts'],
  },
});

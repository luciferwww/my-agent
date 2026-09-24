import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: {
      'my-agent/extension-api': fileURLToPath(new URL('./src/extension/api/index.ts', import.meta.url)),
    },
  },
  test: {
    include: [
      'src/**/*.integration.test.ts',
      'extensions/**/*.integration.test.ts',
      'scripts/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    setupFiles: ['./src/test-setup.ts'],
  },
});

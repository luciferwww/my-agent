import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'src/**/*.integration.test.ts',
      'scripts/**/*.test.ts',
      'scripts/**/*.test.mjs',
    ],
    setupFiles: ['./src/test-setup.ts'],
  },
});

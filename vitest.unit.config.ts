import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    exclude: [
      'src/**/*.integration.test.ts',
      'src/architecture-fitness/**/*.test.ts',
    ],
    setupFiles: ['./src/test-setup.ts'],
  },
});

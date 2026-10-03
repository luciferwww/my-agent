import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/architecture-fitness/**/*.test.ts'],
    setupFiles: ['./src/test-setup.ts'],
  },
});

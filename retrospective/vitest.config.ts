import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['retrospective/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
  },
});

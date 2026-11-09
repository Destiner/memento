import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['experiments/search-relevance/*.test.ts'],
  },
});

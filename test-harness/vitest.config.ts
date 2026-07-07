import { defineConfig } from 'vitest/config';

// Harness-only suite. Kept separate from the product suite (root vitest.config)
// so `bun run test` and `bun run test:harness` stay independent. Fixtures are
// excluded: they run under `bun test`, not vitest, and their imports (bun:test)
// would fail here.
export default defineConfig({
  test: {
    include: ['test-harness/**/*.test.ts'],
    exclude: ['**/fixtures/**', '**/node_modules/**'],
  },
});

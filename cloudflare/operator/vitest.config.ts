import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['cloudflare/operator/rehearsal.test.ts'] } });

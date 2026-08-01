import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { preflightMemento, probeMcpServer } from './preflight.js';

const HARNESS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(HARNESS_ROOT, '..');

describe('probeMcpServer', () => {
  test('resolves when a real stdio MCP server answers initialize', async () => {
    await expect(
      probeMcpServer({
        command: 'bun',
        args: ['run', join(HARNESS_ROOT, 'stubs', 'server.ts')],
        env: { STUB_PROFILE: 'tracker' },
      }),
    ).resolves.toBeUndefined();
  });

  test('rejects with stderr when the server dies before the handshake', async () => {
    await expect(
      probeMcpServer({
        command: 'bun',
        args: ['-e', 'console.error("boom: no such module"); process.exit(1);'],
      }),
    ).rejects.toThrow(/exited with code 1.*boom: no such module/s);
  });

  test('rejects on timeout when the server never responds', async () => {
    await expect(
      probeMcpServer({ command: 'bun', args: ['-e', 'setTimeout(() => {}, 60_000);'] }, 500),
    ).rejects.toThrow(/no initialize response within 500ms/);
  });
});

describe('preflightMemento', () => {
  test('forces a real V2 tool call through the bundled server and observes its log', async () => {
    const entry = await preflightMemento(REPO_ROOT, ['plain']);
    try {
      expect(entry).toMatch(/server\.js$/);
    } finally {
      rmSync(dirname(entry), { recursive: true, force: true });
    }
  });
});

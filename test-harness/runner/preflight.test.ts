import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

import { describe, expect, test } from 'vitest';

import { bundleMementoServer, preflightMemento, probeMcpServer } from './preflight.js';

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
  test.each([{ variants: [] }, { variants: ['plain'] }])(
    'fails closed for $variants',
    async ({ variants }) => {
      await expect(preflightMemento(REPO_ROOT, variants)).rejects.toThrow(/disabled.*cloud-only/);
    },
  );

  test('cannot bundle a production stdio entry', () => {
    expect(() => bundleMementoServer(REPO_ROOT)).toThrow(/No production stdio/);
  });
});

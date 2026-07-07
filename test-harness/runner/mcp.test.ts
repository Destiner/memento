import { describe, expect, test } from 'vitest';

import { generateMcpConfig } from './mcp.js';

describe('generateMcpConfig', () => {
  test('registers memento with its home and variant in the clean env', () => {
    const config = generateMcpConfig({
      memento: { repoRoot: '/repo', mementoHome: '/tmp/home', variant: 'plain' },
      env: 'clean',
    });
    expect(Object.keys(config.mcpServers)).toEqual(['memento']);
    const memento = config.mcpServers.memento;
    expect(memento?.command).toBe('bun');
    expect(memento?.args).toEqual(['run', '/repo/src/main.ts']);
    expect(memento?.env).toEqual({ MEMENTO_HOME: '/tmp/home', MEMENTO_VARIANT: 'plain' });
  });

  test('registers no servers when memento is absent (baseline-no-memento)', () => {
    const config = generateMcpConfig({ memento: null, env: 'clean' });
    expect(config.mcpServers).toEqual({});
  });

  test('throws for the crowded env until the stub server exists', () => {
    expect(() =>
      generateMcpConfig({
        memento: { repoRoot: '/repo', mementoHome: '/tmp/home', variant: 'plain' },
        env: 'crowded',
      }),
    ).toThrow(/not yet implemented/);
  });
});

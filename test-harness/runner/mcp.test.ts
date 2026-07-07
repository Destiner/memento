import { describe, expect, test } from 'vitest';

import { CROWDED_PROFILES, getStubProfile } from '../stubs/profiles.js';
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

  test('adds the fixed stub servers alongside memento in the crowded env', () => {
    const config = generateMcpConfig({
      memento: { repoRoot: '/repo', mementoHome: '/tmp/home', variant: 'plain' },
      env: 'crowded',
      stubs: { stubsDir: '/harness/stubs' },
    });
    const stubServers = CROWDED_PROFILES.map((id) => getStubProfile(id).server);
    expect(Object.keys(config.mcpServers)).toEqual(['memento', ...stubServers]);
    for (const id of CROWDED_PROFILES) {
      const spec = config.mcpServers[getStubProfile(id).server];
      expect(spec?.command).toBe('bun');
      expect(spec?.args).toEqual(['run', '/harness/stubs/server.ts']);
      expect(spec?.env).toEqual({ STUB_PROFILE: id });
    }
  });

  test('registers stubs even when memento is absent (crowded baseline-no-memento)', () => {
    const config = generateMcpConfig({
      memento: null,
      env: 'crowded',
      stubs: { stubsDir: '/harness/stubs' },
    });
    const stubServers = CROWDED_PROFILES.map((id) => getStubProfile(id).server);
    expect(Object.keys(config.mcpServers)).toEqual(stubServers);
  });

  test('throws when the crowded env is requested without a stubs dir', () => {
    expect(() =>
      generateMcpConfig({
        memento: { repoRoot: '/repo', mementoHome: '/tmp/home', variant: 'plain' },
        env: 'crowded',
      }),
    ).toThrow(/requires stubs\.stubsDir/);
  });
});

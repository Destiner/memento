import { describe, expect, test } from 'vitest';

import { CROWDED_PROFILES, STUB_PROFILES, getStubProfile } from './profiles.js';

describe('stub profile catalog', () => {
  test('every crowded profile resolves and carries tools', () => {
    for (const id of CROWDED_PROFILES) {
      const profile = getStubProfile(id);
      expect(profile.id).toBe(id);
      expect(profile.server.length).toBeGreaterThan(0);
      expect(profile.tools.length).toBeGreaterThan(0);
    }
  });

  test('crowded server names are distinct (mcpServers keys must not collide)', () => {
    const names = CROWDED_PROFILES.map((id) => getStubProfile(id).server);
    expect(new Set(names).size).toBe(names.length);
  });

  test('tool names are unique within a profile and descriptions non-empty', () => {
    for (const profile of Object.values(STUB_PROFILES)) {
      const names = profile.tools.map((tool) => tool.name);
      expect(new Set(names).size, `duplicate tool in ${profile.id}`).toBe(names.length);
      for (const tool of profile.tools) {
        expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
        expect(tool.description.trim().length).toBeGreaterThan(0);
      }
    }
  });

  test('getStubProfile throws on an unknown id', () => {
    expect(() => getStubProfile('nope')).toThrow(/unknown stub profile/);
  });
});

import { describe, expect, test } from 'vitest';

import { deepMerge, generateSettings } from './settings.js';

describe('generateSettings', () => {
  test('pre-allows memento tools when registered', () => {
    const settings = generateSettings({ mementoRegistered: true });
    expect(settings).toEqual({ permissions: { allow: ['mcp__memento'] } });
  });

  test('allows nothing when memento is absent', () => {
    const settings = generateSettings({ mementoRegistered: false });
    expect(settings).toEqual({ permissions: { allow: [] } });
  });

  test('merges a config fragment: hooks added, permission rules concatenated', () => {
    const settings = generateSettings({
      mementoRegistered: true,
      fragment: {
        permissions: { allow: ['Bash(bun run:*)'] },
        hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] },
      },
    });
    expect(settings.permissions).toEqual({ allow: ['mcp__memento', 'Bash(bun run:*)'] });
    expect(settings.hooks).toBeDefined();
  });
});

describe('deepMerge', () => {
  test('objects merge, arrays concat, primitives override', () => {
    const merged = deepMerge(
      { a: { x: 1 }, list: [1], keep: 'base' },
      { a: { y: 2 }, list: [2], keep: 'over' },
    );
    expect(merged).toEqual({ a: { x: 1, y: 2 }, list: [1, 2], keep: 'over' });
  });
});

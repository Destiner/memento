import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { configSchema, loadConfig } from './config.js';

const HARNESS_ROOT = fileURLToPath(new URL('..', import.meta.url));

// A minimal valid knob config, reused as the base for negative cases.
const VALID = {
  name: 'tool-desc-trigger',
  knob: 'tool-descriptions',
  variant: 'trigger-list',
  side: 'read',
  portability: 'portable',
  memento_variant: 'shipped',
};

describe('loadConfig', () => {
  test('loads the committed baseline-0 (plain variant, no artifacts)', () => {
    const config = loadConfig(`${HARNESS_ROOT}configs/baseline-0`);
    expect(config.name).toBe('baseline-0');
    expect(config.knob).toBe('none');
    expect(config.memento_variant).toBe('plain');
    expect(config.install).toBeUndefined();
  });

  test('loads the committed baseline-no-memento (Memento unregistered)', () => {
    const config = loadConfig(`${HARNESS_ROOT}configs/baseline-no-memento`);
    expect(config.name).toBe('baseline-no-memento');
    expect(config.memento_variant).toBeNull();
  });

  test('throws when meta.name disagrees with the directory name', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memento-cfg-'));
    writeFileSync(
      join(dir, 'meta.yaml'),
      'name: other\nknob: none\nvariant: none\nside: both\nportability: portable\nmemento_variant: plain\n',
    );
    expect(() => loadConfig(dir)).toThrow(/does not match its directory/);
  });
});

describe('configSchema', () => {
  test('accepts a well-formed config', () => {
    expect(configSchema.safeParse(VALID).success).toBe(true);
  });

  test('rejects unknown fields (strict)', () => {
    expect(configSchema.safeParse({ ...VALID, oops: 1 }).success).toBe(false);
  });

  test('rejects a non-slug name', () => {
    expect(configSchema.safeParse({ ...VALID, name: 'Not A Slug' }).success).toBe(false);
  });

  test('an unregistered config (memento_variant null) must be a baseline (knob none)', () => {
    const base = { ...VALID, name: 'baseline-no-memento', memento_variant: null };
    expect(configSchema.safeParse({ ...base, knob: 'none', variant: 'none' }).success).toBe(true);
    expect(configSchema.safeParse(base).success).toBe(false); // still knob: tool-descriptions
  });

  test('an unregistered config cannot install artifacts', () => {
    const unregistered = {
      ...VALID,
      name: 'baseline-no-memento',
      knob: 'none',
      variant: 'none',
      memento_variant: null,
      install: { claude_md: 'CLAUDE.md' },
    };
    expect(configSchema.safeParse(unregistered).success).toBe(false);
  });

  test('accepts a user-knob config that installs a CLAUDE.md fragment', () => {
    const claudeMd = {
      ...VALID,
      name: 'claude-md-triggers',
      knob: 'claude-md',
      variant: 'conditional-triggers',
      memento_variant: 'plain',
      install: { claude_md: 'CLAUDE.md' },
    };
    expect(configSchema.safeParse(claudeMd).success).toBe(true);
  });

  test('accepts the canonical generated agent instructions', () => {
    expect(
      configSchema.safeParse({
        ...VALID,
        install: { agent_instructions: 'memento' },
      }).success,
    ).toBe(true);
  });

  test('rejects two competing project instruction sources', () => {
    expect(
      configSchema.safeParse({
        ...VALID,
        install: { claude_md: 'AGENTS.md', agent_instructions: 'memento' },
      }).success,
    ).toBe(false);
  });
});

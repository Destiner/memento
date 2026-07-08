import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { loadManifest, manifestSchema } from './manifest.js';
import { planRun, resolveConfigs, resolveScenarios } from './plan.js';

const HARNESS_ROOT = fileURLToPath(new URL('..', import.meta.url));

describe('resolveConfigs', () => {
  test('resolves committed config names, deduping repeats', () => {
    const configs = resolveConfigs(HARNESS_ROOT, [
      'baseline-0',
      'baseline-no-memento',
      'baseline-0',
    ]);
    expect(configs.map((c) => c.name)).toEqual(['baseline-0', 'baseline-no-memento']);
  });

  test('throws on a config with no meta.yaml', () => {
    expect(() => resolveConfigs(HARNESS_ROOT, ['does-not-exist'])).toThrow(/no configs\//);
  });
});

describe('resolveScenarios', () => {
  test('expands a group glob to the scenarios that exist, sorted by id', () => {
    const scenarios = resolveScenarios(HARNESS_ROOT, ['read/*']);
    expect(scenarios.map((s) => s.id)).toEqual([
      'read/email-provider',
      'read/reset-link-domain',
      'read/support-contact',
    ]);
    expect(scenarios.every((s) => s.class === 'should-retrieve')).toBe(true);
  });

  test('matches an exact id and dedups against an overlapping glob', () => {
    const scenarios = resolveScenarios(HARNESS_ROOT, ['read/*', 'read/email-provider']);
    expect(scenarios.map((s) => s.id)).toEqual([
      'read/email-provider',
      'read/reset-link-domain',
      'read/support-contact',
    ]);
  });

  test('throws when a glob matches no scenarios (e.g. a nonexistent group)', () => {
    expect(() => resolveScenarios(HARNESS_ROOT, ['absent/*'])).toThrow(/matched no scenarios/);
  });

  test('expands the should-not-retrieve group to its committed scenarios', () => {
    const scenarios = resolveScenarios(HARNESS_ROOT, ['no-read/*']);
    expect(scenarios.map((s) => s.id)).toEqual([
      'no-read/fix-typo',
      'no-read/guard-empty-email',
      'no-read/rename-constant',
    ]);
    expect(scenarios.every((s) => s.class === 'should-not-retrieve')).toBe(true);
  });

  test('expands the should-not-capture group to its committed scenarios', () => {
    const scenarios = resolveScenarios(HARNESS_ROOT, ['no-write/*']);
    expect(scenarios.map((s) => s.id)).toEqual([
      'no-write/extract-url-helper',
      'no-write/lowercase-email',
      'no-write/reset-token-test',
    ]);
    expect(scenarios.every((s) => s.class === 'should-not-capture')).toBe(true);
  });
});

describe('planRun', () => {
  test('the committed screening-1 manifest resolves end to end', () => {
    // Regression: every config the committed manifest names must have a config dir,
    // and every hook/skill knob it references must be installable — the runner
    // resolves and plans it without throwing (harness-spec §8.1, §9).
    const manifest = loadManifest(join(HARNESS_ROOT, 'manifests', 'screening-1.yaml'));
    const plan = planRun(HARNESS_ROOT, manifest);
    expect(plan.configs.map((c) => c.name).sort()).toEqual([
      'baseline-0',
      'baseline-no-memento',
      'server-instructions',
      'sessionstart-index',
      'tool-desc-trigger',
    ]);
    expect(plan.scenarios.length).toBeGreaterThan(0);
    expect(plan.cells).toHaveLength(plan.configs.length * plan.scenarios.length * manifest.reps);
  });

  test('enumerates config × scenario × rep cells', () => {
    const manifest = manifestSchema.parse({
      name: 'plan-test',
      reps: 2,
      max_spend_usd: 5,
      configs: ['baseline-0', 'baseline-no-memento'],
      scenarios: ['read/email-provider'], // exact id → count-independent of read/*
    });
    const plan = planRun(HARNESS_ROOT, manifest);
    // 2 configs × 1 scenario × 2 reps.
    expect(plan.cells).toHaveLength(4);
    expect(plan.cells.map((c) => c.rep)).toEqual([1, 2, 1, 2]);
    // Config-major order.
    expect(plan.cells.map((c) => c.config.name)).toEqual([
      'baseline-0',
      'baseline-0',
      'baseline-no-memento',
      'baseline-no-memento',
    ]);
  });
});

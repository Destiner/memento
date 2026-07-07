import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { manifestSchema } from './manifest.js';
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
  test('expands a group glob to the scenarios that exist', () => {
    const scenarios = resolveScenarios(HARNESS_ROOT, ['read/*']);
    expect(scenarios.map((s) => s.id)).toEqual(['read/email-provider']);
  });

  test('matches an exact id and dedups against an overlapping glob', () => {
    const scenarios = resolveScenarios(HARNESS_ROOT, ['read/*', 'read/email-provider']);
    expect(scenarios.map((s) => s.id)).toEqual(['read/email-provider']);
  });

  test('throws when a glob matches no scenarios (e.g. an empty class)', () => {
    expect(() => resolveScenarios(HARNESS_ROOT, ['no-read/*'])).toThrow(/matched no scenarios/);
  });
});

describe('planRun', () => {
  test('enumerates config × scenario × rep cells', () => {
    const manifest = manifestSchema.parse({
      name: 'plan-test',
      reps: 2,
      max_spend_usd: 5,
      configs: ['baseline-0', 'baseline-no-memento'],
      scenarios: ['read/*'],
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

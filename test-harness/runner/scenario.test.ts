import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { loadScenario, scenarioSchema } from './scenario.js';

const HARNESS_ROOT = fileURLToPath(new URL('..', import.meta.url));

// A minimal valid should-retrieve scenario, reused as the base for negative cases.
const VALID = {
  id: 'read/example',
  version: 1,
  class: 'should-retrieve',
  fixture: 'fixtures/saas-app',
  task: 'Do the thing.',
  corpus: 'corpus/standard-15',
  seeded_memory: 'corpus/facts/example.md',
  checks: { utility_regex: '(?i)postmark', task_success: 'bun run check' },
  capture_rubric: null,
};

describe('loadScenario', () => {
  test('loads and validates the committed read/email-provider scenario', () => {
    const scenario = loadScenario(`${HARNESS_ROOT}scenarios/read/email-provider/scenario.yaml`);
    expect(scenario.id).toBe('read/email-provider');
    expect(scenario.class).toBe('should-retrieve');
    expect(scenario.seeded_memory).toBe('corpus/facts/email-provider.md');
    expect(scenario.checks.utility_regex).toBe('(?i)postmark');
    expect(scenario.checks.task_success).toBe('bun run check');
  });
});

describe('scenarioSchema', () => {
  test('accepts a well-formed scenario', () => {
    expect(scenarioSchema.safeParse(VALID).success).toBe(true);
  });

  test('rejects unknown fields (strict)', () => {
    expect(scenarioSchema.safeParse({ ...VALID, oops: 1 }).success).toBe(false);
  });

  test('accepts an optional overlay path', () => {
    const parsed = scenarioSchema.safeParse({ ...VALID, overlay: 'overlays/saas-app-mailer' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.overlay).toBe('overlays/saas-app-mailer');
  });

  test('should-retrieve requires a seeded_memory and utility_regex', () => {
    expect(scenarioSchema.safeParse({ ...VALID, seeded_memory: undefined }).success).toBe(false);
    expect(scenarioSchema.safeParse({ ...VALID, checks: { task_success: 'x' } }).success).toBe(
      false,
    );
  });

  test('should-not-retrieve must not seed a memory', () => {
    const base = { ...VALID, class: 'should-not-retrieve', checks: { task_success: 'x' } };
    expect(scenarioSchema.safeParse({ ...base, seeded_memory: undefined }).success).toBe(true);
    expect(scenarioSchema.safeParse(base).success).toBe(false); // still carries seeded_memory
  });

  test('should-capture requires a capture_rubric; should-not-capture forbids it', () => {
    const capture = {
      ...VALID,
      class: 'should-capture',
      seeded_memory: undefined,
      checks: { task_success: 'x' },
    };
    expect(scenarioSchema.safeParse(capture).success).toBe(false); // capture_rubric is null
    expect(scenarioSchema.safeParse({ ...capture, capture_rubric: { must: [] } }).success).toBe(
      true,
    );
    expect(
      scenarioSchema.safeParse({ ...capture, class: 'should-not-capture', capture_rubric: null })
        .success,
    ).toBe(true);
  });
});

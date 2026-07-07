import { describe, expect, test } from 'vitest';

import { baselineDescriptions } from '../src/variants/descriptions.js';
import { USAGE_PROTOCOL } from '../src/variants/instructions.js';
import { CREATE_SUCCESS_NUDGE, EMPTY_SEARCH_NUDGE } from '../src/variants/nudges.js';
import { DEFAULT_VARIANT, listVariants, resolveVariant } from '../src/variants/index.js';

const TOOL_NAMES = [
  'create_memory',
  'read_memory',
  'update_memory',
  'search_memory',
  'answer_memory',
] as const;

describe('resolveVariant', () => {
  test('defaults to baseline and is a behavioral no-op', () => {
    const variant = resolveVariant();
    expect(variant.name).toBe(DEFAULT_VARIANT);
    expect(variant.name).toBe('baseline');
    expect(variant.descriptions).toEqual(baselineDescriptions);
    expect(variant.instructions).toBeUndefined();
    expect(variant.nudges).toEqual({});
  });

  test('every variant defines a non-empty description for every tool', () => {
    for (const name of listVariants()) {
      const variant = resolveVariant(name);
      for (const tool of TOOL_NAMES) {
        expect(variant.descriptions[tool]?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  test('server-instructions adds the usage protocol and nothing else', () => {
    const variant = resolveVariant('server-instructions');
    expect(variant.instructions).toBe(USAGE_PROTOCOL);
    expect(variant.descriptions).toEqual(baselineDescriptions);
    expect(variant.nudges).toEqual({});
  });

  test('result-nudges sets both nudges and leaves instructions empty', () => {
    const variant = resolveVariant('result-nudges');
    expect(variant.instructions).toBeUndefined();
    expect(variant.nudges.emptySearch).toBe(EMPTY_SEARCH_NUDGE);
    expect(variant.nudges.createSuccess).toBe(CREATE_SUCCESS_NUDGE);
  });

  test('throws a helpful error for an unknown variant', () => {
    expect(() => resolveVariant('nope')).toThrow(/Unknown MEMENTO_VARIANT "nope"/);
    expect(() => resolveVariant('nope')).toThrow(/baseline/);
  });
});

import { describe, expect, test } from 'vitest';

import { plainDescriptions, triggerListDescriptions } from '../src/variants/descriptions.js';
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
  test('defaults to shipped-v2 (all screening-cleared auto knobs on)', () => {
    const variant = resolveVariant();
    expect(variant.name).toBe(DEFAULT_VARIANT);
    expect(variant.name).toBe('shipped-v2');
    expect(variant.descriptions).toEqual(triggerListDescriptions);
    expect(variant.instructions).toBeTruthy();
    expect(variant.nudges.emptySearch).toBeTruthy();
    expect(variant.nudges.createSuccess).toBeTruthy();
  });

  test('shipped stays the pre-experiment behavior verbatim (descriptions arm)', () => {
    const variant = resolveVariant('shipped');
    expect(variant.descriptions).toEqual(triggerListDescriptions);
    expect(variant.instructions).toBeUndefined();
    expect(variant.nudges).toEqual({});
  });

  test('there is no variant named baseline (collides with baseline-0)', () => {
    expect(listVariants()).not.toContain('baseline');
    expect(() => resolveVariant('baseline')).toThrow(/Unknown MEMENTO_VARIANT/);
  });

  test('plain is baseline-0: neutral descriptions, no instructions, no nudges', () => {
    const variant = resolveVariant('plain');
    expect(variant.descriptions).toEqual(plainDescriptions);
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

  test('the descriptions knob is a real ablation: plain strips §11 guidance', () => {
    expect(triggerListDescriptions.search_memory).toMatch(/self-contained edits/);
    expect(plainDescriptions.search_memory).not.toMatch(/self-contained edits/);
    for (const tool of TOOL_NAMES) {
      expect(plainDescriptions[tool]).not.toBe(triggerListDescriptions[tool]);
    }
  });

  test('single-knob variants flip one dimension from the plain floor', () => {
    const instructions = resolveVariant('server-instructions');
    expect(instructions.descriptions).toEqual(plainDescriptions);
    expect(instructions.instructions).toBe(USAGE_PROTOCOL);
    expect(instructions.nudges).toEqual({});

    const nudges = resolveVariant('result-nudges');
    expect(nudges.descriptions).toEqual(plainDescriptions);
    expect(nudges.instructions).toBeUndefined();
    expect(nudges.nudges.emptySearch).toBe(EMPTY_SEARCH_NUDGE);
    expect(nudges.nudges.createSuccess).toBe(CREATE_SUCCESS_NUDGE);
  });

  test('throws a helpful error for an unknown variant', () => {
    expect(() => resolveVariant('nope')).toThrow(/Unknown MEMENTO_VARIANT "nope"/);
    expect(() => resolveVariant('nope')).toThrow(/plain/);
  });
});

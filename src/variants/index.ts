// Variant registry for the MEMENTO_VARIANT switch (harness prerequisite §3.1,
// §11.1). A variant is a version-controlled bundle of context-engineering knob
// settings the server selects at startup: tool descriptions, the server
// `instructions` field, and tool-result nudges. This is the only Memento code
// the test harness requires; the harness picks a variant per rep via the
// MEMENTO_VARIANT env var and each config's meta.yaml pins the value.
//
// Variants are composed from independent knob-dimension tables (descriptions.ts,
// instructions.ts, nudges.ts) so Phase-2 combinations are just new entries here.
// `baseline` differs from shipped behavior on nothing.

import { baselineDescriptions, type DescriptionSet } from './descriptions.js';
import { USAGE_PROTOCOL } from './instructions.js';
import { CREATE_SUCCESS_NUDGE, EMPTY_SEARCH_NUDGE, type NudgeSet } from './nudges.js';

export type { ToolName, DescriptionSet } from './descriptions.js';
export type { NudgeSet } from './nudges.js';

export interface VariantConfig {
  name: string;
  descriptions: DescriptionSet;
  // Undefined leaves the MCP `instructions` field unset.
  instructions?: string;
  nudges: NudgeSet;
}

export const DEFAULT_VARIANT = 'baseline';

const VARIANTS: Record<string, VariantConfig> = {
  baseline: {
    name: 'baseline',
    descriptions: baselineDescriptions,
    nudges: {},
  },
  'server-instructions': {
    name: 'server-instructions',
    descriptions: baselineDescriptions,
    instructions: USAGE_PROTOCOL,
    nudges: {},
  },
  'result-nudges': {
    name: 'result-nudges',
    descriptions: baselineDescriptions,
    nudges: {
      emptySearch: EMPTY_SEARCH_NUDGE,
      createSuccess: CREATE_SUCCESS_NUDGE,
    },
  },
};

/** Names of every registered variant, sorted for stable error messages. */
export function listVariants(): string[] {
  return Object.keys(VARIANTS).sort();
}

/**
 * Resolve a variant by name. Throws a descriptive startup error for an unknown
 * name so a mistyped MEMENTO_VARIANT fails loudly instead of silently running
 * baseline (which would invalidate a harness rep without warning).
 */
export function resolveVariant(name: string = DEFAULT_VARIANT): VariantConfig {
  const variant = VARIANTS[name];
  if (!variant) {
    throw new Error(
      `Unknown MEMENTO_VARIANT "${name}". Valid variants: ${listVariants().join(', ')}.`,
    );
  }
  return variant;
}

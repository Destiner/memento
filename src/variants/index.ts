// Variant registry for the MEMENTO_VARIANT switch (harness prerequisite §3.1,
// §11.1). A variant is a version-controlled bundle of context-engineering knob
// settings the server selects at startup: tool descriptions, the server
// `instructions` field, and tool-result nudges. This is the only Memento code
// the test harness requires; the harness picks a variant per rep via the
// MEMENTO_VARIANT env var and each config's meta.yaml pins the value.
//
// Variants are composed from independent knob-dimension tables (descriptions.ts,
// instructions.ts, nudges.ts) so Phase-2 combinations are just new entries here.
//
// baseline-0 (the harness 0-line, §10) is `plain`: neutral descriptions, no
// instructions, no nudges. Each single-knob variant flips exactly one dimension
// from that floor. `shipped` is the real-world default — today's trigger-list
// descriptions (commit 8db547f) — which is itself the descriptions knob's strong
// arm, deliberately *not* baseline-0. There is intentionally no variant named
// `baseline`: it would collide with baseline-0 and let a misconfigured rep pass
// silently.

import { plainDescriptions, triggerListDescriptions, type DescriptionSet } from './descriptions.js';
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

// Default for normal (non-harness) operation: the shipped trigger-list behavior.
export const DEFAULT_VARIANT = 'shipped';

const VARIANTS: Record<string, VariantConfig> = {
  // baseline-0: neutral floor every knob is measured against.
  plain: {
    name: 'plain',
    descriptions: plainDescriptions,
    nudges: {},
  },
  // Real-world default; = descriptions knob ON, everything else at the floor.
  shipped: {
    name: 'shipped',
    descriptions: triggerListDescriptions,
    nudges: {},
  },
  // Instructions knob ON (plain descriptions + usage-protocol instructions).
  'server-instructions': {
    name: 'server-instructions',
    descriptions: plainDescriptions,
    instructions: USAGE_PROTOCOL,
    nudges: {},
  },
  // Nudges knob ON (plain descriptions + tool-result nudges).
  'result-nudges': {
    name: 'result-nudges',
    descriptions: plainDescriptions,
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
 * the default (which would invalidate a harness rep without warning).
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

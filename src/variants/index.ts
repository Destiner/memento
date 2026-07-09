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
// from that floor. `shipped` is the pre-experiment behavior (trigger-list
// descriptions, commit 8db547f) kept verbatim as the descriptions arm;
// `shipped-v2` is the real-world default. There is intentionally no variant
// named `baseline`: it would collide with baseline-0 and let a misconfigured
// rep pass silently.

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

// Default for normal (non-harness) operation. `shipped-v2` combines the auto
// knobs that individually cleared screening (Phase 1, 2026-07): trigger-list
// descriptions (+0.22 read), the instructions field (+0.33 read / 1.00 write,
// zero false positives), and result nudges (no measured cost; instructions
// resolve their needs-first-call bootstrap problem). The combination itself is
// validated in vivo and by the queued combo screening arm.
export const DEFAULT_VARIANT = 'shipped-v2';

const VARIANTS: Record<string, VariantConfig> = {
  // baseline-0: neutral floor every knob is measured against.
  plain: {
    name: 'plain',
    descriptions: plainDescriptions,
    nudges: {},
  },
  // Pre-experiment shipped behavior; = descriptions knob ON, everything else at
  // the floor. Kept verbatim: harness configs pin it as the descriptions arm.
  shipped: {
    name: 'shipped',
    descriptions: triggerListDescriptions,
    nudges: {},
  },
  // Real-world default: every screening-cleared auto knob ON (see DEFAULT_VARIANT).
  'shipped-v2': {
    name: 'shipped-v2',
    descriptions: triggerListDescriptions,
    instructions: USAGE_PROTOCOL,
    nudges: {
      emptySearch: EMPTY_SEARCH_NUDGE,
      createSuccess: CREATE_SUCCESS_NUDGE,
    },
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

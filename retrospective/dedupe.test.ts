import { describe, expect, it } from 'vitest';

import { assignDuplicates, searchProposalTokens, type DedupeCandidate } from './dedupe.js';
import type { SearchProposal } from './evaluator/schema.js';

describe('assignDuplicates', () => {
  it('collapses the same opportunity proposed at several checkpoints', () => {
    // Verbatim queries from run_dc75ce89, where five checkpoints each proposed
    // recovering the same rationale.
    const duplicates = assignDuplicates(
      candidates([
        'op-shim OP_SHIM_KEY local encrypted store resolving op:// secret references',
        'op-shim OP_SHIM_KEY local encrypted secret store resolving op:// references',
        'op-shim OP_SHIM_KEY local encrypted secret store, migration to credential brokering',
      ]),
    );

    expect([...duplicates.entries()]).toEqual([
      [1, 0],
      [2, 0],
    ]);
  });

  it('keeps distinct opportunities apart', () => {
    const duplicates = assignDuplicates(
      candidates([
        'op-shim OP_SHIM_KEY local encrypted store resolving op:// secret references',
        'user preference for destructive cleanup: backups before deleting secret stores',
      ]),
    );

    expect(duplicates.size).toBe(0);
  });

  it('never collapses a proposal that matched a real operation', () => {
    // Two matches in one group mean the agent really did search twice; dropping
    // the second would erase an operation that happened.
    const [first, second] = candidates([
      'op-shim OP_SHIM_KEY local encrypted store resolving op:// secret references',
      'op-shim OP_SHIM_KEY local encrypted secret store resolving op:// references',
    ]);
    const duplicates = assignDuplicates([
      { ...first!, matched: true },
      { ...second!, matched: true },
    ]);

    expect(duplicates.size).toBe(0);
  });

  it('represents a group by its matched member rather than its earliest', () => {
    const [first, second, third] = candidates([
      'op-shim OP_SHIM_KEY local encrypted store resolving op:// secret references',
      'op-shim OP_SHIM_KEY local encrypted secret store resolving op:// references',
      'op-shim OP_SHIM_KEY local encrypted secret store, op:// resolution rationale',
    ]);
    const duplicates = assignDuplicates([first!, { ...second!, matched: true }, third!]);

    // Index 1 matched, so the group is counted under it and the unmatched
    // members defer to it — the group reads `timely`, not `missed`.
    expect(duplicates.get(0)).toBe(1);
    expect(duplicates.get(2)).toBe(1);
    expect(duplicates.has(1)).toBe(false);
  });

  it('does not collapse across differing scopes', () => {
    const [first, second] = candidates([
      'op-shim OP_SHIM_KEY local encrypted store resolving op:// secret references',
      'op-shim OP_SHIM_KEY local encrypted secret store resolving op:// references',
    ]);
    const duplicates = assignDuplicates([
      { ...first!, scopeKind: 'global' },
      { ...second!, scopeKind: 'projects' },
    ]);

    expect(duplicates.size).toBe(0);
  });

  it('is order-stable, so a rerun of one task reproduces the same grouping', () => {
    const input = candidates([
      'op-shim OP_SHIM_KEY local encrypted store resolving op:// secret references',
      'credential brokering replaced the local secret shim on this machine',
      'op-shim OP_SHIM_KEY local encrypted secret store resolving op:// references',
    ]);

    expect([...assignDuplicates(input).entries()]).toEqual([...assignDuplicates(input).entries()]);
    expect([...assignDuplicates(input).entries()]).toEqual([[2, 0]]);
  });
});

describe('searchProposalTokens', () => {
  it('folds plurals and drops short tokens so wording drift still matches', () => {
    expect(searchProposalTokens(proposal('the secrets in a store'))).toEqual(
      searchProposalTokens(proposal('a secret in the stores')),
    );
  });

  it('ignores the per-checkpoint rationale', () => {
    const base = proposal('op-shim rationale');
    const withRationale: SearchProposal = { ...base, rationale: 'Wholly different prose here.' };

    expect(searchProposalTokens(withRationale)).toEqual(searchProposalTokens(base));
  });

  it('ignores the per-checkpoint intent', () => {
    // Regression guard from run_dc75ce89: these two proposals asked the same
    // question in the same words, and folding their intents in dropped the
    // similarity from 1.00 to 0.36 — masking a repeat instead of finding it.
    const query = 'op-shim OP_SHIM_KEY local encrypted store resolving op:// secret references';
    const inventory = withIntent(
      proposal(query),
      'Find durable memories referencing op-shim or OP_SHIM_KEY so the cleanup plan can list ' +
        'them for update or archival alongside the files, binary, and encrypted store.',
    );
    const recovery = withIntent(
      proposal(query),
      'Inventory every memory that references op-shim or OP_SHIM_KEY so the cleanup plan can ' +
        'update or archive them all, rather than only the one found by filesystem grep.',
    );

    expect(searchProposalTokens(inventory)).toEqual(searchProposalTokens(recovery));
    expect(
      assignDuplicates([
        { index: 0, matched: false, tokens: searchProposalTokens(inventory), scopeKind: 'global' },
        { index: 1, matched: false, tokens: searchProposalTokens(recovery), scopeKind: 'global' },
      ]).get(1),
    ).toBe(0);
  });
});

function withIntent(base: SearchProposal, intent: string): SearchProposal {
  return { ...base, search: { ...base.search, intent } };
}

function candidates(queries: readonly string[]): DedupeCandidate[] {
  return queries.map((query, index) => ({
    index,
    matched: false,
    tokens: searchProposalTokens(proposal(query)),
    scopeKind: 'unresolved_projects',
  }));
}

function proposal(query: string): SearchProposal {
  return {
    checkpointId: 'ses_x:task:evt_a:checkpoint:evt_a',
    kind: 'search',
    rationale: 'Rationale text.',
    search: { intent: '', query, scope: { kind: 'unresolved_projects' } },
  } as unknown as SearchProposal;
}

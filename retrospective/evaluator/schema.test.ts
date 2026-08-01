import { describe, expect, test } from 'vitest';

import {
  createMemoryInputSchema,
  searchMemoriesInputSchema,
} from '../../src/store/memory-schema.js';

import {
  MAX_CAPTURE_PROPOSALS,
  captureProposalBatchSchema,
  captureProposalSchema,
  searchProposalBatchSchema,
} from './schema.js';

const memory = {
  title: 'Provider retries need idempotency keys',
  description: 'The provider can accept a timed-out request before the client retries it.',
  scope: { kind: 'projects' as const, project_ids: ['prj_alpha'] },
  type: 'environment_workflow_quirk' as const,
  body: 'A client timeout does not prove rejection. Reuse an idempotency key on retry.',
  provenance: { source: 'agent_observed' as const, verification: 'observed_once' as const },
};

describe('evaluator schemas', () => {
  test('accept zero proposals and reject unknown fields', () => {
    expect(searchProposalBatchSchema.parse({ proposals: [] })).toEqual({ proposals: [] });
    expect(() => searchProposalBatchSchema.parse({ proposals: [], extra: true })).toThrow();
  });

  test('caps capture proposals mechanically', () => {
    const proposal = {
      kind: 'capture',
      taskId: 'task-1',
      action: 'create',
      targetMemoryId: null,
      memory,
      rationale: 'This changes retry design in future integrations.',
    };
    expect(() =>
      captureProposalBatchSchema.parse({
        summary: 'Investigated provider retry semantics.',
        proposals: Array.from({ length: MAX_CAPTURE_PROPOSALS + 1 }, () => proposal),
      }),
    ).toThrow();
  });

  test('does not allow create proposals to name an update target', () => {
    expect(() =>
      captureProposalSchema.parse({
        kind: 'capture',
        taskId: 'task-1',
        action: 'create',
        targetMemoryId: 'mem_existing',
        memory,
        rationale: 'Would duplicate an existing target.',
      }),
    ).toThrow('create proposals cannot target an existing memory');
  });

  test('allows unresolved project scope only in retrospective proposals', () => {
    const unresolved = { kind: 'unresolved_projects' as const };
    expect(
      searchProposalBatchSchema.parse({
        proposals: [
          {
            kind: 'search',
            checkpointId: 'checkpoint-1',
            search: { query: 'provider retries', scope: unresolved },
            rationale: 'Prior project-specific experience may apply.',
          },
        ],
      }).proposals[0]?.search.scope,
    ).toEqual(unresolved);
    expect(
      captureProposalSchema.parse({
        kind: 'capture',
        taskId: 'task-1',
        action: 'create',
        targetMemoryId: null,
        memory: { ...memory, scope: unresolved },
        rationale: 'The project identity is unavailable in the normalized history.',
      }).memory.scope,
    ).toEqual(unresolved);

    expect(() =>
      searchMemoriesInputSchema.parse({ query: 'provider retries', scope: unresolved }),
    ).toThrow();
    expect(() => createMemoryInputSchema.parse({ ...memory, scope: unresolved })).toThrow();
  });
});

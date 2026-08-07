import { describe, expect, test } from 'vitest';

import { compareOperations } from './compare.js';
import { NORMALIZED_SCHEMA_VERSION, type ActualMemoryOperation } from './model.js';
import type { NormalizedTask } from './tasks.js';
import type { CaptureEvaluation, SearchEvaluation } from './evaluator/schema.js';

const EVALUATOR = {
  provider: 'codex' as const,
  cli: 'codex' as const,
  cliVersion: '1.0.0',
  model: 'test-model',
  promptVersion: '1',
  schemaVersion: '1',
  policyVersion: 'unknown',
};

describe('compareOperations', () => {
  test('matches searches one-to-one and distinguishes timely from late', () => {
    const comparisons = compareOperations(
      task([
        operation('search_early', 2, {
          input: { query: 'webhook duplicate retries' },
          scope: { kind: 'global' },
        }),
        operation('search_late', 9, {
          input: { query: 'email sandbox stream behavior' },
          scope: { kind: 'global' },
        }),
      ]),
      [
        searchEvaluation(4, 'webhook duplicate retries'),
        searchEvaluation(6, 'email sandbox stream behavior'),
      ],
      captureEvaluation(),
    );

    expect(comparisons).toEqual([
      expect.objectContaining({
        proposalIndex: 0,
        actualOperationIds: ['search_early'],
        classification: 'timely',
      }),
      expect.objectContaining({
        proposalIndex: 1,
        actualOperationIds: ['search_late'],
        classification: 'late',
      }),
    ]);
    expect(new Set(comparisons.flatMap((item) => item.actualOperationIds)).size).toBe(2);
  });

  test('counts an opportunity proposed at several checkpoints once', () => {
    const comparisons = compareOperations(
      task([]),
      [
        searchEvaluation(0, 'webhook duplicate retries after a failed delivery'),
        searchEvaluation(4, 'webhook duplicate retry after failed deliveries'),
        searchEvaluation(6, 'email sandbox stream behavior'),
      ],
      captureEvaluation(),
    );

    // Without grouping this task reports three misses for two opportunities, and
    // the count would keep growing with the number of checkpoints.
    const counted = comparisons.filter((item) => item.duplicateOfProposalIndex === undefined);
    expect(counted).toHaveLength(2);
    expect(comparisons.find((item) => item.proposalIndex === 1)).toMatchObject({
      classification: 'missed',
      duplicateOfProposalIndex: 0,
    });
    expect(
      comparisons.find((item) => item.proposalIndex === 2)?.duplicateOfProposalIndex,
    ).toBeUndefined();
  });

  test('lets a repeated opportunity inherit the checkpoint that actually matched', () => {
    const comparisons = compareOperations(
      task([
        operation('search_actual', 6, {
          input: { query: 'webhook duplicate retries after a failed delivery' },
          scope: { kind: 'global' },
        }),
      ]),
      [
        searchEvaluation(0, 'webhook duplicate retries after a failed delivery'),
        searchEvaluation(4, 'webhook duplicate retry after failed deliveries'),
      ],
      captureEvaluation(),
    );

    // The agent searched once and did the right thing, so the opportunity must
    // read as handled rather than as one match plus a phantom miss.
    const matched = comparisons.find((item) => item.actualOperationIds.length > 0);
    expect(matched).toMatchObject({ classification: 'late' });
    const others = comparisons.filter((item) => item !== matched);
    expect(others.every((item) => item.duplicateOfProposalIndex === matched?.proposalIndex)).toBe(
      true,
    );
    expect(comparisons.filter((item) => item.duplicateOfProposalIndex === undefined)).toHaveLength(
      1,
    );
  });

  test('treats a search issued immediately after its checkpoint as timely', () => {
    const comparisons = compareOperations(
      task([
        operation('search_immediate', 2, {
          input: { query: 'webhook duplicate retries' },
          scope: { kind: 'global' },
        }),
      ]),
      [searchEvaluation(0, 'webhook duplicate retries')],
      captureEvaluation(),
    );

    expect(comparisons[0]).toMatchObject({
      actualOperationIds: ['search_immediate'],
      classification: 'timely',
    });
  });

  test('flags a matching search in a different scope', () => {
    const comparisons = compareOperations(
      task([
        operation('search_wrong_scope', 2, {
          input: { query: 'webhook duplicate retries' },
          scope: { kind: 'projects', projectIds: ['prj_PROJECT001'] },
        }),
      ]),
      [searchEvaluation(4, 'webhook duplicate retries')],
      captureEvaluation(),
    );

    expect(comparisons[0]).toMatchObject({ classification: 'incorrect_scope' });
  });

  test('keeps unresolved proposal scopes ambiguous instead of calling them incorrect', () => {
    const search = searchEvaluation(4, 'webhook duplicate retries');
    search.proposals[0]!.search.scope = { kind: 'unresolved_projects' };
    const capture = captureEvaluation(true);
    capture.proposals[0]!.memory.scope = { kind: 'unresolved_projects' };
    const comparisons = compareOperations(
      task([
        operation('search_project', 5, {
          input: { query: 'webhook duplicate retries' },
          scope: { kind: 'projects', projectIds: ['prj_PROJECT001'] },
        }),
        operation('write_project', 7, {
          tool: 'create_memory',
          kind: 'write',
          input: {
            title: 'Webhook retries duplicate sends',
            description: 'Peak delays make retries appear duplicated.',
            scope: { kind: 'projects', project_ids: ['prj_PROJECT001'] },
          },
          scope: { kind: 'projects', projectIds: ['prj_PROJECT001'] },
        }),
      ]),
      [search],
      capture,
    );

    expect(comparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          proposalIndex: 0,
          actualOperationIds: ['search_project'],
          classification: 'ambiguous',
        }),
        expect.objectContaining({
          proposalIndex: 0,
          actualOperationIds: ['write_project'],
          classification: 'ambiguous',
        }),
      ]),
    );
    expect(comparisons.some((item) => item.classification === 'incorrect_scope')).toBe(false);
  });

  test('keeps unmatched proposals and operations separate for review', () => {
    const comparisons = compareOperations(
      task([
        operation('search_unmatched', 2, {
          input: { query: 'completely unrelated topic' },
          scope: { kind: 'global' },
        }),
      ]),
      [searchEvaluation(4, 'webhook duplicate retries')],
      captureEvaluation(),
    );

    expect(comparisons).toEqual([
      expect.objectContaining({ proposalIndex: 0, classification: 'missed' }),
      expect.objectContaining({
        proposalIndex: null,
        actualOperationIds: ['search_unmatched'],
        classification: 'unnecessary_candidate',
      }),
    ]);
  });

  test('does not pair unrelated writes merely because their actions and scopes match', () => {
    const unrelatedWrite = operation('write_unrelated', 5, {
      tool: 'create_memory',
      kind: 'write',
      input: {
        title: 'iOS signing certificates expire',
        description: 'Provisioning must be renewed before release builds.',
        scope: { kind: 'global' },
      },
      scope: { kind: 'global' },
    });

    const comparisons = compareOperations(task([unrelatedWrite]), [], captureEvaluation(true));

    expect(comparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ proposalIndex: 0, classification: 'missed' }),
        expect.objectContaining({
          proposalIndex: null,
          actualOperationIds: ['write_unrelated'],
          classification: 'unnecessary_candidate',
        }),
      ]),
    );
  });

  test('classifies an update using its nested changes scope', () => {
    const capture = updateCaptureEvaluation({
      kind: 'projects',
      project_ids: ['prj_PROJECT001'],
      match: 'all',
    });
    const update = operation('update_nested_scope', 5, {
      tool: 'update_memory',
      kind: 'write',
      input: {
        id: 'mem_01TARGET',
        changes: {
          title: 'Webhook retries duplicate sends',
          description: 'Peak delays make retries appear duplicated.',
          scope: {
            kind: 'projects',
            project_ids: ['prj_PROJECT001'],
            match: 'all',
          },
        },
      },
      scope: undefined,
    });

    const comparisons = compareOperations(task([update]), [], capture);

    expect(comparisons[0]).toMatchObject({
      actualOperationIds: ['update_nested_scope'],
      classification: 'timely',
    });
  });

  test('prefers an update result memory scope when classifying wrong scope', () => {
    const capture = updateCaptureEvaluation({
      kind: 'projects',
      project_ids: ['prj_EXPECTED'],
    });
    const update = operation('update_result_scope', 5, {
      tool: 'update_memory',
      kind: 'write',
      input: {
        id: 'mem_01TARGET',
        changes: { scope: { kind: 'projects', project_ids: ['prj_EXPECTED'] } },
      },
      output: {
        Ok: {
          structuredContent: {
            memory: { scope: { kind: 'projects', project_ids: ['prj_ACTUAL'] } },
          },
        },
      },
      scope: undefined,
    });

    const comparisons = compareOperations(task([update]), [], capture);

    expect(comparisons[0]).toMatchObject({
      actualOperationIds: ['update_result_scope'],
      classification: 'incorrect_scope',
    });
  });

  test('distinguishes failed writes and unconfirmed transcript operations', () => {
    const failed = operation('write_failed', 5, {
      tool: 'create_memory',
      kind: 'write',
      input: {
        title: 'Webhook retries duplicate sends',
        description: 'Peak delays make retries appear duplicated.',
        scope: { kind: 'global' },
      },
      output: { Ok: { structuredContent: { outcome: 'duplicate_candidates' } } },
    });
    const transcript = operation('search_transcript', 7, {
      input: { query: 'email sandbox stream' },
      scope: { kind: 'global' },
      outcome: 'unknown',
      resultEventId: undefined,
    });

    const comparisons = compareOperations(task([failed, transcript]), [], captureEvaluation(true));

    expect(comparisons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          actualOperationIds: ['write_failed'],
          classification: 'attempted_not_stored',
        }),
        expect.objectContaining({
          actualOperationIds: ['search_transcript'],
          classification: 'transcript_only',
        }),
      ]),
    );
  });
});

function task(actualOperations: ActualMemoryOperation[]): NormalizedTask {
  return {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    id: 'task_1',
    sessionId: 'session_1',
    index: 0,
    rootUserEventId: 'event_0',
    client: 'codex',
    policyVersion: 'unknown',
    startSequence: 0,
    endSequence: 10,
    events: [],
    actualOperations,
  };
}

function operation(
  id: string,
  sequence: number,
  overrides: Partial<ActualMemoryOperation> = {},
): ActualMemoryOperation {
  return {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    id,
    sessionId: 'session_1',
    threadId: 'thread_1',
    callEventId: `event_${id}`,
    resultEventId: `result_${id}`,
    sequence,
    tool: 'search_memories',
    kind: 'search',
    sourceToolName: 'mcp__memento__search_memories',
    callId: `call_${id}`,
    outcome: 'success',
    ...overrides,
  };
}

function searchEvaluation(sequence: number, query: string): SearchEvaluation {
  const checkpoint = {
    id: `checkpoint_${sequence}`,
    eventId: `event_${sequence}`,
    sequence,
    kind: sequence === 0 ? ('start' as const) : ('meaningful' as const),
    reason: 'A durable decision became relevant.',
  };
  return {
    checkpoint,
    proposals: [
      {
        kind: 'search',
        checkpointId: checkpoint.id,
        search: { query, scope: { kind: 'global' } },
        rationale: 'Look for prior experience.',
      },
    ],
    evaluator: EVALUATOR,
  };
}

function captureEvaluation(withProposal = false): CaptureEvaluation {
  return {
    summary: 'Completed a task.',
    proposals: withProposal
      ? [
          {
            kind: 'capture',
            taskId: 'task_1',
            action: 'create',
            targetMemoryId: null,
            memory: {
              title: 'Webhook retries duplicate sends',
              description: 'Peak delays make retries appear duplicated.',
              scope: { kind: 'global' },
              type: 'debugging_pattern',
              body: 'Use the delivery timestamp to distinguish delayed retries.',
              provenance: { source: 'agent_observed' },
            },
            rationale: 'The reusable root cause is not in the repository.',
          },
        ]
      : [],
    evaluator: EVALUATOR,
  };
}

function updateCaptureEvaluation(
  scope: { kind: 'global' } | { kind: 'projects'; project_ids: string[]; match?: 'any' | 'all' },
): CaptureEvaluation {
  const capture = captureEvaluation(true);
  const proposal = capture.proposals[0]!;
  proposal.action = 'update';
  proposal.targetMemoryId = 'mem_01TARGET';
  proposal.memory.scope = scope;
  return capture;
}

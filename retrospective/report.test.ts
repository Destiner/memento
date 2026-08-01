import { describe, expect, test } from 'vitest';

import { RetrospectiveStore } from './db/store.js';
import { buildReviewedReport, renderReviewedReport } from './report.js';

describe('reviewed report', () => {
  test('uses accepted proposal-backed items for activation and capture denominators', () => {
    const store = fixture();
    for (const id of [
      'comparison_search_activated',
      'comparison_search_missed',
      'comparison_capture_stored',
      'comparison_capture_failed',
      'comparison_actual_only',
    ]) {
      store.recordReview(id, { action: 'approve', actor: 'timur' });
    }
    store.recordReview('comparison_rejected', {
      action: 'reject',
      actor: 'timur',
      reason: 'Search was not warranted.',
    });
    store.recordReview('comparison_duplicate', {
      action: 'duplicate',
      actor: 'timur',
      reason: 'Already represented.',
      targetMemoryId: 'mem_EXISTING01',
    });

    const report = buildReviewedReport(store, 'run_1');
    expect(report).toMatchObject({
      reviewed: 7,
      unreviewedExcluded: 1,
      byDecision: { approved: 5, rejected: 1, duplicate: 1 },
      activation: { eligibleSessions: 2, activatedSessions: 1, rate: 0.5 },
      capture: { eligibleProposals: 2, capturedProposals: 1, rate: 0.5 },
      promotion: { approvedWrites: 0 },
    });
    const rendered = renderReviewedReport(report);
    expect(rendered).toContain('Search activation: 1/2 eligible sessions (50.0%)');
    expect(rendered).toContain('Learning capture: 1/2 eligible proposals (50.0%)');
    expect(rendered).toContain('1 pending excluded');
    store.close();
  });

  test('renders n/a instead of inventing a rate with no eligible proposals', () => {
    const store = fixture();
    const report = buildReviewedReport(store, 'run_1');
    expect(report.activation.rate).toBeNull();
    expect(report.capture.rate).toBeNull();
    expect(renderReviewedReport(report)).toContain('eligible sessions (n/a)');
    store.close();
  });
});

function fixture(): RetrospectiveStore {
  const store = new RetrospectiveStore(':memory:', () => new Date('2026-08-01T10:00:00Z'));
  store.createRun({ id: 'run_1', sourcePolicyVersion: 'unknown', pipelineVersion: '1' });
  store.ingestSession('run_1', sessionWithOperations());
  store.ingestSession('run_1', emptySession());
  insertTask(store, 'task_1', 'session_1', 0, 3);
  insertTask(store, 'task_2', 'session_2', 0, 0);
  insertCheckpoint(store, 'checkpoint_1', 'task_1');
  insertCheckpoint(store, 'checkpoint_2', 'task_2');

  const searchActivated = proposal(store, 'search_activated', 'task_1', 'search', 'checkpoint_1');
  comparison(store, 'comparison_search_activated', 'task_1', 'search', searchActivated, {
    actualOperationId: 'op_search',
    label: 'timely',
  });
  const searchPending = proposal(store, 'search_pending', 'task_1', 'search', 'checkpoint_1');
  comparison(store, 'comparison_pending', 'task_1', 'search', searchPending, { label: 'missed' });
  const searchMissed = proposal(store, 'search_missed', 'task_2', 'search', 'checkpoint_2');
  comparison(store, 'comparison_search_missed', 'task_2', 'search', searchMissed, {
    actualOperationId: 'op_transcript_search',
    label: 'transcript_only',
  });
  const rejected = proposal(store, 'search_rejected', 'task_2', 'search', 'checkpoint_2');
  comparison(store, 'comparison_rejected', 'task_2', 'search', rejected, { label: 'missed' });

  const captureStored = proposal(store, 'capture_stored', 'task_1', 'create');
  comparison(store, 'comparison_capture_stored', 'task_1', 'write', captureStored, {
    actualOperationId: 'op_write',
    label: 'timely',
  });
  const captureFailed = proposal(store, 'capture_failed', 'task_1', 'create');
  comparison(store, 'comparison_capture_failed', 'task_1', 'write', captureFailed, {
    actualOperationId: 'op_failed',
    label: 'attempted_not_stored',
  });
  const duplicate = proposal(store, 'capture_duplicate', 'task_1', 'create');
  comparison(store, 'comparison_duplicate', 'task_1', 'write', duplicate, { label: 'missed' });
  comparison(store, 'comparison_actual_only', 'task_1', 'write', undefined, {
    actualOperationId: 'op_unnecessary',
    label: 'unnecessary_candidate',
  });
  return store;
}

function sessionWithOperations() {
  const operations = [
    { id: 'op_search', tool: 'search_memories', kind: 'search', outcome: 'success' },
    { id: 'op_write', tool: 'create_memory', kind: 'write', outcome: 'success' },
    { id: 'op_failed', tool: 'create_memory', kind: 'write', outcome: 'error' },
    { id: 'op_unnecessary', tool: 'create_memory', kind: 'write', outcome: 'success' },
  ] as const;
  return {
    schemaVersion: 1 as const,
    id: 'session_1',
    client: 'codex' as const,
    sourceSessionIds: ['source-session-1'],
    sourceIds: ['source-1'],
    rootThreadId: 'thread_1',
    threads: [{ id: 'thread_1', sourceSessionId: 'source-session-1' }],
    events: operations.map((operation, sequence) => ({
      schemaVersion: 1 as const,
      id: `event_${operation.id}`,
      sessionId: 'session_1',
      threadId: 'thread_1',
      sequence,
      kind: 'tool_call' as const,
      role: 'assistant' as const,
      actualOperationId: operation.id,
    })),
    actualOperations: operations.map((operation, sequence) => ({
      schemaVersion: 1 as const,
      id: operation.id,
      sessionId: 'session_1',
      threadId: 'thread_1',
      callEventId: `event_${operation.id}`,
      sequence,
      tool: operation.tool,
      kind: operation.kind,
      sourceToolName: operation.tool,
      callId: `call_${operation.id}`,
      outcome: operation.outcome,
    })),
    policyVersion: 'unknown' as const,
    warnings: [],
  };
}

function emptySession() {
  return {
    schemaVersion: 1 as const,
    id: 'session_2',
    client: 'claude-code' as const,
    sourceSessionIds: ['source-session-2'],
    sourceIds: ['source-2'],
    rootThreadId: 'thread_2',
    threads: [{ id: 'thread_2', sourceSessionId: 'source-session-2' }],
    events: [
      {
        schemaVersion: 1 as const,
        id: 'event_transcript_search',
        sessionId: 'session_2',
        threadId: 'thread_2',
        sequence: 0,
        kind: 'tool_call' as const,
        role: 'assistant' as const,
        actualOperationId: 'op_transcript_search',
      },
    ],
    actualOperations: [
      {
        schemaVersion: 1 as const,
        id: 'op_transcript_search',
        sessionId: 'session_2',
        threadId: 'thread_2',
        callEventId: 'event_transcript_search',
        sequence: 0,
        tool: 'search_memories' as const,
        kind: 'search' as const,
        sourceToolName: 'search_memories',
        callId: 'call_transcript_search',
        outcome: 'unknown' as const,
      },
    ],
    policyVersion: 'unknown' as const,
    warnings: [],
  };
}

function insertTask(
  store: RetrospectiveStore,
  id: string,
  sessionId: string,
  startSequence: number,
  endSequence: number,
): void {
  store.insertTask({
    runId: 'run_1',
    id,
    sessionId,
    ordinal: 0,
    startSequence,
    endSequence,
  });
}

function insertCheckpoint(store: RetrospectiveStore, id: string, taskId: string): void {
  store.insertCheckpoint({
    runId: 'run_1',
    id,
    taskId,
    ordinal: 0,
    afterSequence: 0,
    reason: 'Task started.',
    context: {},
  });
}

function proposal(
  store: RetrospectiveStore,
  id: string,
  taskId: string,
  kind: 'search' | 'create',
  checkpointId?: string,
): string {
  return store.insertProposal({
    id: `proposal_${id}`,
    runId: 'run_1',
    taskId,
    ...(checkpointId === undefined ? {} : { checkpointId }),
    ordinal: Number.parseInt(id.replace(/\D/g, ''), 10) || id.length,
    kind,
    payload: { id },
    evaluator: {
      provider: 'codex',
      model: 'test',
      promptVersion: '1',
      schemaVersion: '1',
    },
  });
}

function comparison(
  store: RetrospectiveStore,
  id: string,
  taskId: string,
  kind: 'search' | 'write',
  proposalId: string | undefined,
  fields: {
    actualOperationId?: string;
    label:
      'timely' | 'missed' | 'attempted_not_stored' | 'transcript_only' | 'unnecessary_candidate';
  },
): void {
  store.insertComparison({
    id,
    runId: 'run_1',
    taskId,
    kind,
    ...(proposalId === undefined ? {} : { proposalId }),
    ...(fields.actualOperationId === undefined
      ? {}
      : { actualOperationId: fields.actualOperationId }),
    label: fields.label,
    explanation: 'Comparison.',
  });
}

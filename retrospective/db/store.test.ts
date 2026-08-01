import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { NORMALIZED_SCHEMA_VERSION, type NormalizedSession } from '../model.js';
import { RETROSPECTIVE_SCHEMA_VERSION } from './schema.js';
import { openRetrospectiveStore, RETROSPECTIVE_DB_FILENAME, RetrospectiveStore } from './store.js';
import type { EvaluatorIdentity } from './types.js';

const NOW = new Date('2026-08-01T10:00:00.000Z');
const EVALUATOR: EvaluatorIdentity = {
  provider: 'claude-code',
  cli: 'claude',
  cliVersion: '1.2.3',
  model: 'test-model',
  promptVersion: 'retrospective-1',
  schemaVersion: 1,
};

describe('RetrospectiveStore', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  test('migrates a durable database in MEMENTO_HOME without rebuilding it', async () => {
    const home = tempHome();
    let store = await openRetrospectiveStore({ home, now: () => NOW });
    expect(store.schemaVersion()).toBe(RETROSPECTIVE_SCHEMA_VERSION);
    store.createRun(run());
    store.close();

    store = await openRetrospectiveStore({ home, now: () => NOW });
    expect(store.counts().runs).toBe(1);
    expect(store.schemaVersion()).toBe(RETROSPECTIVE_SCHEMA_VERSION);
    store.close();
  });

  test.runIf(process.platform !== 'win32')('keeps internal evaluation data private', async () => {
    const home = tempHome();
    const store = await openRetrospectiveStore({ home, now: () => NOW });
    store.close();

    expect(statSync(join(home, 'retrospective')).mode & 0o777).toBe(0o700);
    expect(statSync(join(home, 'retrospective', RETROSPECTIVE_DB_FILENAME)).mode & 0o777).toBe(
      0o600,
    );
  });

  test('ingests a redacted normalized session transactionally and idempotently', () => {
    const store = memoryStore();
    store.createRun(run());
    store.ingestSession('run_test', session());
    store.ingestSession('run_test', session());

    expect(store.counts()).toMatchObject({
      sessions: 1,
      session_threads: 1,
      normalized_events: 2,
      actual_operations: 1,
    });

    expect(() =>
      store.ingestSession('run_test', { ...session(), policyVersion: 'different' }),
    ).toThrow(/Idempotency conflict/);
    expect(store.counts().sessions).toBe(1);
    store.close();
  });

  test('treats an edited revision as the final approved decision', () => {
    const store = preparedStore();
    const comparisonId = insertProposalAndComparison(store);

    store.recordReview(comparisonId, {
      action: 'edit',
      actor: 'timur',
      reason: 'Tighten the query.',
      label: 'missed',
      actualOperationId: null,
      revision: { kind: 'search', query: 'webhook retry signal' },
    });
    const decision = store.reviewItem(comparisonId);
    expect(store.reviewItem(comparisonId)).toMatchObject({
      state: 'approved',
      revision: { kind: 'search', query: 'webhook retry signal' },
      reviewEvents: [{ action: 'edit' }],
    });
    expect(decision.reviewEvents).toHaveLength(1);
    expect(() =>
      store.recordReview(comparisonId, {
        action: 'reject',
        actor: 'timur',
        reason: 'Changed my mind.',
      }),
    ).toThrow(/decisions are final/);
    store.close();
  });

  test('requires reasons and duplicate targets', () => {
    const store = preparedStore();
    const comparisonId = insertProposalAndComparison(store);

    expect(() =>
      store.recordReview(comparisonId, { action: 'reject', actor: 'timur', reason: ' ' }),
    ).toThrow(/requires a reason/);
    expect(() =>
      store.recordReview(comparisonId, {
        action: 'duplicate',
        actor: 'timur',
        reason: 'Already recorded.',
        targetMemoryId: ' ',
      }),
    ).toThrow(/target memory id/);
    expect(store.counts().review_events).toBe(0);
    store.close();
  });

  test('enforces one-to-one proposal and actual-operation matching', () => {
    const store = preparedStore();
    const comparisonId = insertProposalAndComparison(store, 'op_search');
    expect(comparisonId).toMatch(/^cmp_/);

    expect(() =>
      store.insertComparison({
        runId: 'run_test',
        taskId: 'task_1',
        kind: 'search',
        proposalId: 'prop_search',
        label: 'missed',
        explanation: 'Cannot match the proposal twice.',
      }),
    ).toThrow();
    expect(() =>
      store.insertComparison({
        runId: 'run_test',
        taskId: 'task_1',
        kind: 'search',
        actualOperationId: 'op_search',
        label: 'unnecessary_candidate',
        explanation: 'Cannot match the operation twice.',
      }),
    ).toThrow();
    store.close();
  });

  test('records an explicit reviewed match override without rewriting the comparison', () => {
    const store = preparedStore();
    const comparisonId = insertProposalAndComparison(store, 'op_search');

    store.recordReview(comparisonId, {
      action: 'edit',
      actor: 'timur',
      reason: 'The original search addressed a different question.',
      label: 'missed',
      actualOperationId: null,
      revision: { kind: 'search', query: 'webhook delivery timestamps' },
    });

    expect(store.reviewItem(comparisonId)).toMatchObject({
      originalActualOperationId: 'op_search',
      label: 'missed',
      reviewEvents: [{ action: 'edit', actualOperationId: null }],
    });
    expect(store.reviewItem(comparisonId)).not.toHaveProperty('actualOperationId');
    expect(
      store.query<{ actual_operation_id: string }>(
        'SELECT actual_operation_id FROM comparisons WHERE id = ?',
        comparisonId,
      )[0]?.actual_operation_id,
    ).toBe('op_search');
    store.close();
  });

  test('rejects a reviewed match outside the task instead of guessing', () => {
    const store = preparedStore();
    const comparisonId = insertProposalAndComparison(store);

    expect(() =>
      store.recordReview(comparisonId, {
        action: 'edit',
        actor: 'timur',
        reason: 'Try to attach an unknown operation.',
        label: 'timely',
        actualOperationId: 'op_missing',
        revision: { kind: 'search', query: 'webhook retries' },
      }),
    ).toThrow(/not a search operation in task/);
    expect(store.reviewItem(comparisonId).reviewEvents).toEqual([]);
    store.close();
  });

  test('can rematch an operation after rejecting its actual-only comparison', () => {
    const store = preparedStore();
    const actualOnly = store.insertComparison({
      runId: 'run_test',
      taskId: 'task_1',
      kind: 'search',
      actualOperationId: 'op_search',
      label: 'unnecessary_candidate',
      explanation: 'No proposal matched this operation.',
    });
    store.recordReview(actualOnly, {
      action: 'reject',
      actor: 'timur',
      reason: 'This operation belongs to the missed proposal.',
    });
    const proposalComparison = insertProposalAndComparison(store);

    store.recordReview(proposalComparison, {
      action: 'edit',
      actor: 'timur',
      reason: 'Attach the operation after correcting the semantic match.',
      label: 'timely',
      actualOperationId: 'op_search',
      revision: { kind: 'search', query: 'webhook retries' },
    });

    expect(store.reviewItem(proposalComparison)).toMatchObject({
      state: 'approved',
      actualOperationId: 'op_search',
      actualOperation: { outcome: 'success' },
    });
    store.close();
  });

  test('reuses successful attempts but allows retry after duplicate candidates', () => {
    const store = preparedStore();
    const comparisonId = insertProposalAndComparison(store);
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const first = store.beginPromotion(comparisonId, { action: 'create' });
    const completed = store.finishPromotion(first.id, {
      status: 'duplicate_candidates',
      result: { candidates: ['mem_EXISTING'] },
    });

    expect(completed.status).toBe('duplicate_candidates');
    const retry = store.beginPromotion(comparisonId, { action: 'create' });
    expect(retry).toMatchObject({ attempt: 2, status: 'started' });
    const succeeded = store.finishPromotion(retry.id, {
      status: 'succeeded',
      result: { outcome: 'created' },
      promotedMemoryId: 'mem_CREATED001',
    });
    expect(store.beginPromotion(comparisonId, { action: 'create' })).toEqual(succeeded);
    expect(store.counts().promotion_attempts).toBe(2);
    store.close();
  });

  test('stores the same normalized identities independently in different runs', () => {
    const store = memoryStore();
    store.createRun(run());
    store.createRun({ ...run(), id: 'run_second' });
    store.ingestSession('run_test', session());
    store.ingestSession('run_second', session());
    store.insertTask({
      runId: 'run_test',
      id: 'task_1',
      sessionId: 'session_test',
      ordinal: 0,
      startSequence: 0,
      endSequence: 1,
    });
    store.insertTask({
      runId: 'run_second',
      id: 'task_1',
      sessionId: 'session_test',
      ordinal: 0,
      startSequence: 0,
      endSequence: 1,
    });

    expect(store.counts()).toMatchObject({ sessions: 2, normalized_events: 4, tasks: 2 });
    expect(store.hasTask('run_test', 'task_1')).toBe(true);
    expect(store.hasTask('run_second', 'task_1')).toBe(true);
    store.close();
  });

  test('records a terminal task failure idempotently as a resumable outcome', () => {
    const store = memoryStore();
    store.createRun(run());
    store.ingestSession('run_test', session());
    const failure = {
      runId: 'run_test',
      id: 'task_failed',
      sessionId: 'session_test',
      ordinal: 0,
      startSequence: 0,
      endSequence: 1,
      error: 'Error: evaluator output was invalid',
    };

    store.recordTaskFailure(failure);
    store.recordTaskFailure(failure);

    expect(store.hasTask('run_test', 'task_failed')).toBe(false);
    expect(store.hasTaskOutcome('run_test', 'task_failed')).toBe(true);
    expect(store.listTaskFailures('run_test')).toEqual([
      { ...failure, createdAt: NOW.toISOString() },
    ]);
    expect(store.counts().task_failures).toBe(1);
    store.close();
  });

  function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'memento-retrospective-'));
    homes.push(home);
    return home;
  }
});

function memoryStore(): RetrospectiveStore {
  return new RetrospectiveStore(':memory:', () => NOW);
}

function run() {
  return {
    id: 'run_test',
    sourcePolicyVersion: 'unknown',
    pipelineVersion: '1',
    evaluator: EVALUATOR,
  };
}

function session(): NormalizedSession {
  return {
    schemaVersion: NORMALIZED_SCHEMA_VERSION,
    id: 'session_test',
    client: 'codex',
    sourceSessionIds: ['source-session-hash'],
    sourceIds: ['source-hash'],
    rootThreadId: 'thread_root',
    threads: [{ id: 'thread_root', sourceSessionId: 'source-session-hash' }],
    events: [
      {
        schemaVersion: NORMALIZED_SCHEMA_VERSION,
        id: 'event_user',
        sessionId: 'session_test',
        threadId: 'thread_root',
        sequence: 0,
        kind: 'user_message',
        role: 'user',
        text: 'Debug the webhook retries.',
      },
      {
        schemaVersion: NORMALIZED_SCHEMA_VERSION,
        id: 'event_search',
        sessionId: 'session_test',
        threadId: 'thread_root',
        sequence: 1,
        kind: 'tool_call',
        role: 'assistant',
        actualOperationId: 'op_search',
        toolCall: {
          callId: 'call_search',
          name: 'mcp__memento__search_memories',
          input: { query: 'webhook retries' },
          isMemento: true,
        },
      },
    ],
    actualOperations: [
      {
        schemaVersion: NORMALIZED_SCHEMA_VERSION,
        id: 'op_search',
        sessionId: 'session_test',
        threadId: 'thread_root',
        callEventId: 'event_search',
        sequence: 1,
        tool: 'search_memories',
        kind: 'search',
        sourceToolName: 'mcp__memento__search_memories',
        callId: 'call_search',
        outcome: 'success',
        scope: { kind: 'global' },
      },
    ],
    policyVersion: 'unknown',
    warnings: [],
  };
}

function preparedStore(): RetrospectiveStore {
  const store = memoryStore();
  store.createRun(run());
  store.ingestSession('run_test', session());
  store.insertTask({
    runId: 'run_test',
    id: 'task_1',
    sessionId: 'session_test',
    ordinal: 0,
    startSequence: 0,
    endSequence: 1,
  });
  store.insertCheckpoint({
    runId: 'run_test',
    id: 'checkpoint_1',
    taskId: 'task_1',
    ordinal: 0,
    afterSequence: 0,
    reason: 'Task started.',
    context: { through: 0 },
  });
  return store;
}

function insertProposalAndComparison(
  store: RetrospectiveStore,
  actualOperationId?: string,
): string {
  store.insertProposal({
    id: 'prop_search',
    runId: 'run_test',
    taskId: 'task_1',
    checkpointId: 'checkpoint_1',
    ordinal: 0,
    kind: 'search',
    payload: { kind: 'search', query: 'webhook retries' },
    rationale: 'This task resembles a recurring failure.',
    evaluator: EVALUATOR,
  });
  return store.insertComparison({
    runId: 'run_test',
    taskId: 'task_1',
    kind: 'search',
    proposalId: 'prop_search',
    ...(actualOperationId === undefined ? {} : { actualOperationId }),
    label: actualOperationId === undefined ? 'missed' : 'timely',
    explanation:
      actualOperationId === undefined ? 'No search occurred.' : 'Search occurred in time.',
  });
}

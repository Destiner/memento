import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { resolvePaths } from '../src/config.js';
import { createMemory } from '../src/store/memory-create.js';
import { MemoryIndex } from '../src/store/search-index.js';
import { RetrospectiveStore } from './db/store.js';
import { applyReview, applyReviewFromHome, reviewQueue } from './review.js';

describe('review workflow', () => {
  test('validates a full edit and treats it as final approval', () => {
    const { store, comparisonId } = fixture('write');
    applyReview(store, comparisonId, {
      action: 'edit',
      actor: 'timur',
      reason: 'Clarify the durable signal.',
      label: 'missed',
      actualOperationId: null,
      revision: captureProposal('Webhook delivery timestamps identify delayed retries.'),
    });

    expect(store.reviewItem(comparisonId)).toMatchObject({
      state: 'approved',
      label: 'missed',
      originalLabel: 'missed',
      revision: {
        memory: { body: 'Webhook delivery timestamps identify delayed retries.' },
      },
    });
    expect(reviewQueue(store)).toEqual([]);
    store.close();
  });

  test('rejects invalid edits before appending a review event', () => {
    const { store, comparisonId } = fixture('write');
    expect(() =>
      applyReview(store, comparisonId, {
        action: 'edit',
        actor: 'timur',
        reason: 'Bad shape.',
        label: 'missed',
        actualOperationId: null,
        revision: { action: 'create' },
      }),
    ).toThrow();
    expect(store.reviewItem(comparisonId).reviewEvents).toEqual([]);
    store.close();
  });

  test('requires the reviewed label to agree with the explicit match', () => {
    const { store, comparisonId } = fixture('write');

    expect(() =>
      applyReview(store, comparisonId, {
        action: 'edit',
        actor: 'timur',
        reason: 'Inconsistent reviewed ground truth.',
        label: 'timely',
        actualOperationId: null,
        revision: captureProposal('Webhook delivery timestamps identify delayed retries.'),
      }),
    ).toThrow(/without an actual-operation match.*missed/);
    expect(store.reviewItem(comparisonId).reviewEvents).toEqual([]);
    store.close();
  });

  test('redacts a valid edit before persisting it', () => {
    const { store, comparisonId } = fixture('write');
    applyReview(store, comparisonId, {
      action: 'edit',
      actor: 'timur',
      reason: 'Remove an accidentally pasted credential.',
      label: 'missed',
      actualOperationId: null,
      revision: captureProposal('Retry with TOKEN=supersecret after renewing the lease.'),
    });

    const body = (store.reviewItem(comparisonId).revision as { memory: { body: string } }).memory
      .body;
    expect(body).toContain('[REDACTED:SECRET]');
    expect(body).not.toContain('supersecret');
    store.close();
  });

  test('requires an append-only edit to canonicalize unresolved write scope', () => {
    const { store, comparisonId } = fixture('write', true);

    expect(() => applyReview(store, comparisonId, { action: 'approve', actor: 'timur' })).toThrow(
      /unresolved_projects.*edited to a canonical scope/,
    );
    expect(() =>
      applyReview(store, comparisonId, {
        action: 'edit',
        actor: 'timur',
        reason: 'Project is still unresolved.',
        label: 'ambiguous',
        actualOperationId: null,
        revision: captureProposal('Keep the learning.', { kind: 'unresolved_projects' }),
      }),
    ).toThrow(/replace unresolved_projects with a canonical scope/);
    expect(store.reviewItem(comparisonId).reviewEvents).toEqual([]);

    applyReview(store, comparisonId, {
      action: 'edit',
      actor: 'timur',
      reason: 'Resolved the owning project.',
      label: 'missed',
      actualOperationId: null,
      revision: captureProposal('Keep the learning.', {
        kind: 'projects',
        project_ids: ['prj_RESOLVED01'],
      }),
    });

    expect(store.reviewItem(comparisonId)).toMatchObject({
      state: 'approved',
      revision: { memory: { scope: { kind: 'projects', project_ids: ['prj_RESOLVED01'] } } },
      reviewEvents: [{ action: 'edit' }],
    });
    store.close();
  });

  test('reopens a previously approved unresolved proposal for its corrective edit', () => {
    const { store, comparisonId } = fixture('write', true);
    store.recordReview(comparisonId, { action: 'approve', actor: 'legacy-reviewer' });

    expect(reviewQueue(store).map((item) => item.id)).toEqual([comparisonId]);
    applyReview(store, comparisonId, {
      action: 'edit',
      actor: 'timur',
      reason: 'Resolved the owning project.',
      label: 'missed',
      actualOperationId: null,
      revision: captureProposal('Keep the learning.', {
        kind: 'projects',
        project_ids: ['prj_RESOLVED01'],
      }),
    });

    expect(store.reviewItem(comparisonId)).toMatchObject({
      state: 'approved',
      reviewEvents: [{ action: 'approve' }, { action: 'edit' }],
    });
    expect(reviewQueue(store)).toEqual([]);
    store.close();
  });

  test('allows duplicate decisions only for proposed writes', () => {
    const { store, comparisonId } = fixture('search');
    expect(() =>
      applyReview(store, comparisonId, {
        action: 'duplicate',
        actor: 'timur',
        reason: 'Already exists.',
        targetMemoryId: 'mem_EXISTING001',
      }),
    ).toThrow(/Only proposed memory writes/);
    store.close();
  });

  test('requires an operator-selected duplicate target to exist in the durable store', async () => {
    const { store, comparisonId } = fixture('write');
    const home = mkdtempSync(join(tmpdir(), 'memento-review-'));
    try {
      await expect(
        applyReviewFromHome(
          store,
          comparisonId,
          {
            action: 'duplicate',
            actor: 'timur',
            reason: 'Already exists.',
            targetMemoryId: 'mem_MISSING001',
          },
          home,
        ),
      ).rejects.toThrow();
      expect(store.reviewItem(comparisonId).reviewEvents).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
      store.close();
    }
  });

  test('snapshots an update target when approval uses the configured home', async () => {
    const { store, comparisonId } = fixture('write', false, 'update');
    const home = mkdtempSync(join(tmpdir(), 'memento-review-update-'));
    const paths = resolvePaths(home);
    const index = new MemoryIndex();
    try {
      await createMemory(
        {
          title: 'Existing webhook behavior',
          description: 'Existing notes about webhook retries.',
          scope: { kind: 'global' },
          type: 'debugging_pattern',
          body: 'Existing webhook retry notes.',
          provenance: { source: 'agent_observed' },
        },
        {
          memoriesDir: paths.memories,
          projectsDir: paths.projects,
          index,
          makeId: () => 'mem_EXISTING01',
        },
      );

      await applyReviewFromHome(store, comparisonId, { action: 'approve', actor: 'timur' }, home);

      expect(store.reviewItem(comparisonId).targetMemorySnapshot).toMatchObject({
        memoryId: 'mem_EXISTING01',
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    } finally {
      index.close();
      rmSync(home, { recursive: true, force: true });
      store.close();
    }
  });

  test('reopens an approved write after duplicate candidates for an append-only edit', () => {
    const { store, comparisonId } = fixture('write');
    applyReview(store, comparisonId, { action: 'approve', actor: 'timur' });
    const attempt = store.beginPromotion(comparisonId, { action: 'create' });
    store.finishPromotion(attempt.id, {
      status: 'duplicate_candidates',
      result: { candidates: ['mem_EXISTING01'] },
    });

    expect(reviewQueue(store).map((item) => item.id)).toEqual([comparisonId]);
    applyReview(store, comparisonId, {
      action: 'edit',
      actor: 'timur',
      reason: 'This is materially distinct from the candidate.',
      label: 'missed',
      actualOperationId: null,
      revision: captureProposal('The distinguishing signal is the provider delivery timestamp.'),
    });

    expect(store.reviewItem(comparisonId)).toMatchObject({
      state: 'approved',
      reviewEvents: [{ action: 'approve' }, { action: 'edit' }],
    });
    expect(() => applyReview(store, comparisonId, { action: 'approve', actor: 'timur' })).toThrow(
      /decisions are final/,
    );
    const retry = store.beginPromotion(comparisonId, { action: 'create', revision: 2 });
    store.finishPromotion(retry.id, {
      status: 'succeeded',
      result: { outcome: 'created' },
      promotedMemoryId: 'mem_NEW0001',
    });
    expect(reviewQueue(store)).toEqual([]);
    store.close();
  });

  test('allows an approved duplicate candidate to be linked to its target', () => {
    const { store, comparisonId } = fixture('write');
    applyReview(store, comparisonId, { action: 'approve', actor: 'timur' });
    const attempt = store.beginPromotion(comparisonId, { action: 'create' });
    store.finishPromotion(attempt.id, {
      status: 'ambiguous',
      result: { reason: 'Target needs review.' },
    });

    applyReview(store, comparisonId, {
      action: 'duplicate',
      actor: 'timur',
      reason: 'The existing memory already captures this learning.',
      targetMemoryId: 'mem_EXISTING01',
    });

    expect(store.reviewItem(comparisonId)).toMatchObject({
      state: 'duplicate',
      reviewEvents: [
        { action: 'approve' },
        { action: 'duplicate', duplicateTargetMemoryId: 'mem_EXISTING01' },
      ],
    });
    expect(reviewQueue(store)).toEqual([]);
    store.close();
  });

  test('keeps a failed promotion visible and allows an append-only repair decision', () => {
    const { store, comparisonId } = fixture('write');
    applyReview(store, comparisonId, { action: 'approve', actor: 'timur' });
    const attempt = store.beginPromotion(comparisonId, { action: 'create' });
    store.finishPromotion(attempt.id, {
      status: 'failed',
      error: 'The reviewed target no longer exists.',
    });

    expect(reviewQueue(store).map((item) => item.id)).toEqual([comparisonId]);
    applyReview(store, comparisonId, {
      action: 'reject',
      actor: 'timur',
      reason: 'The learning is no longer durable.',
    });

    expect(store.reviewItem(comparisonId)).toMatchObject({
      state: 'rejected',
      reviewEvents: [{ action: 'approve' }, { action: 'reject' }],
    });
    expect(reviewQueue(store)).toEqual([]);
    store.close();
  });
});

function fixture(
  kind: 'search' | 'write',
  unresolvedProjectScope = false,
  action: 'create' | 'update' = 'create',
) {
  const store = new RetrospectiveStore(':memory:', () => new Date('2026-08-01T10:00:00Z'));
  store.createRun({
    id: 'run_1',
    sourcePolicyVersion: 'unknown',
    pipelineVersion: '1',
  });
  store.ingestSession('run_1', {
    schemaVersion: 1,
    id: 'session_1',
    client: 'codex',
    sourceSessionIds: ['source-session'],
    sourceIds: ['source'],
    rootThreadId: 'thread_1',
    threads: [{ id: 'thread_1', sourceSessionId: 'source-session' }],
    events: [],
    actualOperations: [],
    policyVersion: 'unknown',
    warnings: [],
  });
  store.insertTask({
    runId: 'run_1',
    id: 'task_1',
    sessionId: 'session_1',
    ordinal: 0,
    startSequence: 0,
    endSequence: 0,
  });
  if (kind === 'search') {
    store.insertCheckpoint({
      runId: 'run_1',
      id: 'checkpoint_1',
      taskId: 'task_1',
      ordinal: 0,
      afterSequence: 0,
      reason: 'Task start.',
      context: {},
    });
  }
  const proposalId = store.insertProposal({
    runId: 'run_1',
    taskId: 'task_1',
    ...(kind === 'search' ? { checkpointId: 'checkpoint_1' } : {}),
    ordinal: 0,
    kind: kind === 'search' ? 'search' : action,
    payload:
      kind === 'search'
        ? {
            kind: 'search',
            checkpointId: 'checkpoint_1',
            search: { query: 'webhook retries', scope: { kind: 'global' } },
            rationale: 'Look for the known root cause.',
          }
        : captureProposal(
            'Delayed webhooks make retries appear duplicated.',
            unresolvedProjectScope ? { kind: 'unresolved_projects' } : { kind: 'global' },
            action,
          ),
    evaluator: {
      provider: 'codex',
      model: 'test',
      promptVersion: '1',
      schemaVersion: '1',
    },
  });
  const comparisonId = store.insertComparison({
    runId: 'run_1',
    taskId: 'task_1',
    kind,
    proposalId,
    label: 'missed',
    explanation: 'The proposed operation did not occur.',
  });
  return { store, comparisonId };
}

type ProposalScope =
  | { kind: 'global' }
  | { kind: 'projects'; project_ids: string[] }
  | { kind: 'unresolved_projects' };

function captureProposal(
  body: string,
  scope: ProposalScope = { kind: 'global' },
  action: 'create' | 'update' = 'create',
) {
  return {
    kind: 'capture' as const,
    taskId: 'task_1',
    action,
    targetMemoryId: action === 'update' ? 'mem_EXISTING01' : null,
    memory: {
      title: 'Webhook retries duplicate sends',
      description: 'Peak delays make retries appear duplicated.',
      scope,
      type: 'debugging_pattern' as const,
      body,
      provenance: { source: 'agent_observed' as const },
    },
    rationale: 'The root cause is durable and absent from the repository.',
  };
}

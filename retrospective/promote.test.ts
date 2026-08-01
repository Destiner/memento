import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import { createProject } from '../src/store/project-create.js';
import { createMemory, MemoryCreatedIndexError } from '../src/store/memory-create.js';
import { getMemory } from '../src/store/memory-get.js';
import type { MemoryDetail } from '../src/store/memory-schema.js';
import { MemoryUpdatedPersistenceError } from '../src/store/memory-update.js';
import { openIndex } from '../src/store/index-open.js';
import { MemoryIndex } from '../src/store/search-index.js';
import { resolvePaths } from '../src/config.js';
import { RetrospectiveStore } from './db/store.js';
import type { CaptureProposal } from './evaluator/schema.js';
import type { JsonValue } from './model.js';
import { targetMemorySnapshot } from './memory-snapshot.js';
import type { PromotionOperations } from './promote.js';
import {
  promoteApprovedWrite,
  promoteApprovedWriteFromHome,
  reconcileStartedPromotionFromHome,
} from './promote.js';
import { applyReviewFromHome } from './review.js';

describe('promotion', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('promotes end to end from a redacted cwd and stored stable project id', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memento-promotion-'));
    temporaryDirectories.push(root);
    const projectsDir = join(root, 'projects');
    const memoriesDir = join(root, 'memories');
    await createProject(
      { name: 'Memento', description: 'Local memory layer for coding agents.' },
      { projectsDir, makeId: () => 'prj_RESOLVED01' },
    );
    const index = new MemoryIndex();
    const { store, comparisonId } = fixture('write');
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });

    try {
      const result = await promoteApprovedWrite(store, comparisonId, {
        memoriesDir,
        projectsDir,
        index,
      });
      expect(result).toMatchObject({ status: 'succeeded', promotedMemoryId: expect.any(String) });
      expect(JSON.stringify(result.result)).not.toContain(root);
      expect(JSON.stringify(result.result)).toContain('[REDACTED:PATH]');
      expect(readdirSync(memoriesDir)).toHaveLength(1);
    } finally {
      index.close();
      store.close();
    }
  });

  test('validates stable scope and leaves duplicate candidates unpromoted', async () => {
    const { store, comparisonId } = fixture('write');
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const create = vi
      .fn()
      .mockResolvedValueOnce({ outcome: 'duplicate_candidates', candidates: [{ id: 'mem_OLD' }] })
      .mockResolvedValueOnce({ outcome: 'created', id: 'mem_NEW', path: '/internal/memory.md' });
    const operations = operationStubs({ createMemory: create });

    const first = await promoteApprovedWrite(store, comparisonId, options(operations));
    expect(first).toMatchObject({ status: 'duplicate_candidates' });
    expect(first).not.toHaveProperty('promotedMemoryId');
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: { kind: 'projects', project_ids: ['prj_RESOLVED01'] },
      }),
      expect.anything(),
    );
    expect(create.mock.calls[0]?.[0]).not.toHaveProperty('force_create');
    expect(operations.resolveProject).not.toHaveBeenCalled();
    expect(operations.assertProjectsRegistered).toHaveBeenCalledWith('/internal/projects', [
      'prj_RESOLVED01',
    ]);

    const second = await promoteApprovedWrite(store, comparisonId, options(operations));
    expect(second).toMatchObject({ status: 'succeeded', promotedMemoryId: 'mem_NEW' });
    const third = await promoteApprovedWrite(store, comparisonId, options(operations));
    expect(third).toEqual(second);
    expect(create).toHaveBeenCalledTimes(2);
    store.close();
  });

  test('does not write when current project resolution is ambiguous', async () => {
    const { store, comparisonId } = fixture('write', 'create', false);
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const create = vi.fn();
    const operations = operationStubs({
      createMemory: create,
      resolveProject: vi.fn().mockResolvedValue({
        outcome: 'candidates',
        matched_on: 'name',
        candidates: [],
      }),
    });

    const result = await promoteApprovedWrite(store, comparisonId, options(operations));
    expect(result).toMatchObject({ status: 'ambiguous' });
    expect(create).not.toHaveBeenCalled();
    store.close();
  });

  test('routes approved updates through updateMemory with the reviewed target', async () => {
    const { store, comparisonId } = fixture('write', 'update');
    const current = existingMemory();
    store.recordReview(comparisonId, {
      action: 'approve',
      actor: 'timur',
      targetMemorySnapshot: targetMemorySnapshot(current),
    });
    const update = vi.fn().mockResolvedValue({
      id: 'mem_EXISTING01',
      path: '/internal/memory.md',
      updated: true,
      memory: {},
      dropped_evidence: [],
    });

    const result = await promoteApprovedWrite(
      store,
      comparisonId,
      options(
        operationStubs({ getMemory: vi.fn().mockResolvedValue(current), updateMemory: update }),
      ),
    );

    expect(result).toMatchObject({ status: 'succeeded', promotedMemoryId: 'mem_EXISTING01' });
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mem_EXISTING01',
        old_text: current.body,
        new_text: expect.any(String),
        replace: true,
        changes: expect.objectContaining({
          provenance: expect.objectContaining({
            verification: 'observed_once',
            evidence: [],
          }),
        }),
      }),
      expect.objectContaining({
        expectedCurrentSha256: targetMemorySnapshot(current).sha256,
      }),
    );
    store.close();
  });

  test('reviews and promotes a real update through canonical Markdown and the index', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memento-update-promotion-'));
    temporaryDirectories.push(root);
    const paths = resolvePaths(root);
    await createProject(
      { name: 'Memento', description: 'Local memory layer for coding agents.' },
      { projectsDir: paths.projects, makeId: () => 'prj_RESOLVED01' },
    );
    const opened = await openIndex({ indexDir: paths.index, memoriesDir: paths.memories });
    await createMemory(
      {
        title: 'Existing webhook behavior',
        description: 'Existing notes about webhook retries.',
        scope: { kind: 'projects', project_ids: ['prj_RESOLVED01'] },
        type: 'debugging_pattern',
        body: 'Existing webhook retry notes.',
        provenance: { source: 'agent_observed' },
      },
      {
        memoriesDir: paths.memories,
        projectsDir: paths.projects,
        index: opened.index,
        makeId: () => 'mem_EXISTING01',
      },
    );
    opened.index.close();
    const { store, comparisonId } = fixture('write', 'update');
    try {
      await applyReviewFromHome(store, comparisonId, { action: 'approve', actor: 'timur' }, root);
      const result = await promoteApprovedWriteFromHome(store, comparisonId, root);
      expect(result).toMatchObject({ status: 'succeeded', promotedMemoryId: 'mem_EXISTING01' });

      const memory = await getMemory(
        { id: 'mem_EXISTING01' },
        { memoriesDir: paths.memories, projectsDir: paths.projects },
      );
      expect(memory).toMatchObject({
        title: 'Webhook retries duplicate sends',
        body: 'Webhook delivery timestamps identify delayed retries.',
      });
      const verifiedIndex = await openIndex({ indexDir: paths.index, memoriesDir: paths.memories });
      expect(
        verifiedIndex.index.search('delivery timestamps', {
          scope: { kind: 'projects', project_ids: ['prj_RESOLVED01'] },
          limit: 5,
        }),
      ).toEqual([expect.objectContaining({ id: 'mem_EXISTING01' })]);
      verifiedIndex.index.close();
    } finally {
      store.close();
    }
  });

  test('refuses an update when its target changed after review', async () => {
    const { store, comparisonId } = fixture('write', 'update');
    const reviewed = existingMemory();
    store.recordReview(comparisonId, {
      action: 'approve',
      actor: 'timur',
      targetMemorySnapshot: targetMemorySnapshot(reviewed),
    });
    const changed = { ...reviewed, body: 'Someone corrected this after the review.' };
    const update = vi.fn();

    const result = await promoteApprovedWrite(
      store,
      comparisonId,
      options(
        operationStubs({ getMemory: vi.fn().mockResolvedValue(changed), updateMemory: update }),
      ),
    );

    expect(result).toMatchObject({
      status: 'ambiguous',
      result: { reason: expect.stringMatching(/changed after review/) },
    });
    expect(update).not.toHaveBeenCalled();
    store.close();
  });

  test('refuses a legacy update approval without a reviewed target snapshot', async () => {
    const { store, comparisonId } = fixture('write', 'update');
    store.recordReview(comparisonId, { action: 'approve', actor: 'legacy-reviewer' });
    const update = vi.fn();

    const result = await promoteApprovedWrite(
      store,
      comparisonId,
      options(operationStubs({ updateMemory: update })),
    );

    expect(result).toMatchObject({
      status: 'ambiguous',
      result: { reason: expect.stringMatching(/not snapshotted/) },
    });
    expect(update).not.toHaveBeenCalled();
    store.close();
  });

  test('redacts a failed promotion diagnostic and allows a new attempt', async () => {
    const { store, comparisonId } = fixture('write');
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error('TOKEN=supersecret at /Users/alice/private/repo'))
      .mockResolvedValueOnce({ outcome: 'created', id: 'mem_NEW', path: '/internal/memory.md' });
    const operations = operationStubs({ createMemory: create });

    const failed = await promoteApprovedWrite(store, comparisonId, options(operations));
    expect(failed).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('[REDACTED:SECRET]'),
    });
    expect(failed.error).toContain('[REDACTED:PATH]');
    expect(failed.error).not.toContain('supersecret');

    const retried = await promoteApprovedWrite(store, comparisonId, options(operations));
    expect(retried).toMatchObject({ attempt: 2, status: 'succeeded' });
    store.close();
  });

  test('leaves a post-write index failure started until explicit reconciliation', async () => {
    const { store, comparisonId } = fixture('write');
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const create = vi
      .fn()
      .mockRejectedValue(
        new MemoryCreatedIndexError(
          'mem_DURABLE001',
          '/internal/memories/mem_DURABLE001-memory.md',
          new Error('index repair failed'),
        ),
      );
    const operations = operationStubs({ createMemory: create });

    await expect(promoteApprovedWrite(store, comparisonId, options(operations))).rejects.toThrow(
      /was written.*reconcile before retrying/,
    );
    expect(store.latestPromotion(comparisonId)).toMatchObject({ status: 'started' });

    const resumed = await promoteApprovedWrite(store, comparisonId, options(operations));
    expect(resumed).toMatchObject({ status: 'started' });
    expect(create).toHaveBeenCalledTimes(1);
    store.close();
  });

  test('leaves a successful write started when succeeded bookkeeping fails', async () => {
    const { store, comparisonId } = fixture('write');
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const create = vi
      .fn()
      .mockResolvedValue({ outcome: 'created', id: 'mem_DURABLE002', path: '/internal/memory.md' });
    const originalFinish = store.finishPromotion.bind(store);
    vi.spyOn(store, 'finishPromotion').mockImplementationOnce(() => {
      throw new Error('evaluation database unavailable');
    });

    await expect(
      promoteApprovedWrite(store, comparisonId, options(operationStubs({ createMemory: create }))),
    ).rejects.toThrow(/evaluation database unavailable/);
    expect(store.latestPromotion(comparisonId)).toMatchObject({ status: 'started' });
    expect(create).toHaveBeenCalledTimes(1);
    vi.mocked(store.finishPromotion).mockImplementation(originalFinish);
    expect(
      (
        await promoteApprovedWrite(
          store,
          comparisonId,
          options(operationStubs({ createMemory: create })),
        )
      ).status,
    ).toBe('started');
    expect(create).toHaveBeenCalledTimes(1);
    store.close();
  });

  test('leaves a post-write update failure started until explicit reconciliation', async () => {
    const { store, comparisonId } = fixture('write', 'update');
    const current = existingMemory();
    store.recordReview(comparisonId, {
      action: 'approve',
      actor: 'timur',
      targetMemorySnapshot: targetMemorySnapshot(current),
    });
    const update = vi
      .fn()
      .mockRejectedValue(
        new MemoryUpdatedPersistenceError(
          current.id,
          '/internal/memories/mem_EXISTING01-memory.md',
          new Error('index repair failed'),
        ),
      );
    const operations = operationStubs({
      getMemory: vi.fn().mockResolvedValue(current),
      updateMemory: update,
    });

    await expect(promoteApprovedWrite(store, comparisonId, options(operations))).rejects.toThrow(
      /was written.*reconcile before retrying/,
    );
    expect(store.latestPromotion(comparisonId)).toMatchObject({ status: 'started' });
    expect((await promoteApprovedWrite(store, comparisonId, options(operations))).status).toBe(
      'started',
    );
    expect(update).toHaveBeenCalledTimes(1);
    store.close();
  });

  test('never promotes search review items', async () => {
    const { store, comparisonId } = fixture('search');
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    await expect(
      promoteApprovedWrite(store, comparisonId, options(operationStubs())),
    ).rejects.toThrow(/Search proposals are evaluation-only/);
    expect(store.counts().promotion_attempts).toBe(0);
    store.close();
  });

  test('does not write an approved proposal whose actual capture already succeeded', async () => {
    const { store, comparisonId } = fixture('write', 'create', true, true);
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const create = vi.fn();

    await expect(
      promoteApprovedWrite(store, comparisonId, options(operationStubs({ createMemory: create }))),
    ).rejects.toThrow(/refusing to write it again/);
    expect(create).not.toHaveBeenCalled();
    expect(store.counts().promotion_attempts).toBe(0);
    store.close();
  });

  test('does not let a reviewed label disguise a successful actual write', async () => {
    const { store, comparisonId } = fixture('write', 'create', true, true);
    store.recordReview(comparisonId, {
      action: 'edit',
      actor: 'timur',
      reason: 'Correct the classification but retain the observed match.',
      label: 'attempted_not_stored',
      actualOperationId: 'op_actual_write',
      revision: store.reviewItem(comparisonId).proposal!,
    });
    const create = vi.fn();

    await expect(
      promoteApprovedWrite(store, comparisonId, options(operationStubs({ createMemory: create }))),
    ).rejects.toThrow(/without objective failure evidence/);
    expect(create).not.toHaveBeenCalled();
    store.close();
  });

  test('does not treat a generic actual write error as proof that nothing was stored', async () => {
    const { store, comparisonId } = fixture('write', 'create', true, 'error');
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const create = vi.fn();

    await expect(
      promoteApprovedWrite(store, comparisonId, options(operationStubs({ createMemory: create }))),
    ).rejects.toThrow(/without objective failure evidence/);
    expect(create).not.toHaveBeenCalled();
    store.close();
  });

  test('accepts a reviewer-authorized registered multi-project scope', async () => {
    const { store, comparisonId } = fixture('write');
    const revision = structuredClone(store.reviewItem(comparisonId).proposal) as CaptureProposal;
    revision.memory.scope = {
      kind: 'projects',
      project_ids: ['prj_RESOLVED01', 'prj_OTHER0001'],
    };
    store.recordReview(comparisonId, {
      action: 'edit',
      actor: 'timur',
      reason: 'The learning is shared by both registered projects.',
      label: 'missed',
      actualOperationId: null,
      revision: revision as unknown as JsonValue,
    });
    const create = vi
      .fn()
      .mockResolvedValue({ outcome: 'created', id: 'mem_MULTI0001', path: '/internal/memory.md' });
    const operations = operationStubs({ createMemory: create });

    const result = await promoteApprovedWrite(store, comparisonId, options(operations));

    expect(result).toMatchObject({ status: 'succeeded', promotedMemoryId: 'mem_MULTI0001' });
    expect(operations.assertProjectsRegistered).toHaveBeenCalledWith('/internal/projects', [
      'prj_RESOLVED01',
      'prj_OTHER0001',
    ]);
    expect(operations.resolveProject).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          kind: 'projects',
          project_ids: ['prj_RESOLVED01', 'prj_OTHER0001'],
        },
      }),
      expect.anything(),
    );
    store.close();
  });

  test('refuses unresolved project scope before claiming or calling store operations', async () => {
    const { store, comparisonId } = fixture('write', 'create', true, false, true);
    store.recordReview(comparisonId, { action: 'approve', actor: 'legacy-reviewer' });
    const operations = operationStubs();

    await expect(promoteApprovedWrite(store, comparisonId, options(operations))).rejects.toThrow(
      /unresolved_projects.*Append an edit review.*canonical projects scope/,
    );

    expect(store.counts().promotion_attempts).toBe(0);
    expect(operations.resolveProject).not.toHaveBeenCalled();
    expect(operations.assertProjectsRegistered).not.toHaveBeenCalled();
    expect(operations.createMemory).not.toHaveBeenCalled();
    expect(operations.updateMemory).not.toHaveBeenCalled();
    store.close();
  });

  test('does not replay an in-flight attempt after an interrupted process', async () => {
    const { store, comparisonId } = fixture('write');
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const existing = store.beginPromotion(comparisonId, { action: 'create' });
    const create = vi.fn();

    const result = await promoteApprovedWrite(
      store,
      comparisonId,
      options(operationStubs({ createMemory: create })),
    );

    expect(result).toEqual(existing);
    expect(create).not.toHaveBeenCalled();
    store.close();
  });

  test('atomically refuses a promotion claim after the review decision changes', () => {
    const { store, comparisonId } = fixture('write');
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const approved = store.reviewItem(comparisonId);
    const failed = store.beginPromotion(comparisonId, approved.proposal!);
    store.finishPromotion(failed.id, { status: 'failed', error: 'Pre-write validation failed.' });
    store.recordReview(comparisonId, {
      action: 'reject',
      actor: 'timur',
      reason: 'The proposed learning is not durable.',
    });

    expect(() =>
      store.claimPromotion(comparisonId, approved.proposal!, approved.reviewEvents.length),
    ).toThrow(/changed before promotion could be claimed/);
    expect(store.latestPromotion(comparisonId)?.attempt).toBe(1);
    store.close();
  });

  test('rebuilds the derived index before reconciling a started promotion as succeeded', async () => {
    const root = mkdtempSync(join(tmpdir(), 'memento-reconcile-'));
    temporaryDirectories.push(root);
    const paths = resolvePaths(root);
    const seedIndex = new MemoryIndex();
    const { store, comparisonId } = fixture('write');
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const started = store.beginPromotion(comparisonId, store.reviewItem(comparisonId).proposal!);
    try {
      await createMemory(
        {
          title: 'Reconciled memory',
          description: 'A durable write whose process stopped before bookkeeping.',
          scope: { kind: 'global' },
          type: 'other',
          body: 'The canonical file exists and must be re-indexed.',
          provenance: { source: 'agent_observed' },
        },
        {
          memoriesDir: paths.memories,
          projectsDir: paths.projects,
          index: seedIndex,
          makeId: () => 'mem_RECONCILE1',
        },
      );

      const reconciled = await reconcileStartedPromotionFromHome(store, comparisonId, {
        status: 'succeeded',
        actor: 'timur',
        reason: 'Verified the canonical file after the interrupted write.',
        memoryId: 'mem_RECONCILE1',
        home: root,
      });
      expect(reconciled).toMatchObject({
        id: started.id,
        status: 'succeeded',
        promotedMemoryId: 'mem_RECONCILE1',
      });
      const reopened = await openIndex({ indexDir: paths.index, memoriesDir: paths.memories });
      expect(reopened.index.count()).toBe(1);
      reopened.index.close();
    } finally {
      seedIndex.close();
      store.close();
    }
  });

  test('manually reconciles an interrupted attempt as failed so it can be retried', async () => {
    const { store, comparisonId } = fixture('write');
    store.recordReview(comparisonId, { action: 'approve', actor: 'timur' });
    const started = store.beginPromotion(comparisonId, { action: 'create' });

    const reconciled = await reconcileStartedPromotionFromHome(store, comparisonId, {
      status: 'failed',
      actor: 'timur',
      reason: 'Verified that no memory was written.',
      home: '/unused',
    });

    expect(reconciled).toMatchObject({ id: started.id, status: 'failed' });
    const create = vi
      .fn()
      .mockResolvedValue({ outcome: 'created', id: 'mem_RETRY0001', path: '/internal/memory.md' });
    const retried = await promoteApprovedWrite(
      store,
      comparisonId,
      options(operationStubs({ createMemory: create })),
    );
    expect(retried).toMatchObject({ attempt: 2, status: 'succeeded' });
    store.close();
  });
});

function options(operations: PromotionOperations) {
  return {
    memoriesDir: '/internal/memories',
    projectsDir: '/internal/projects',
    index: {} as MemoryIndex,
    operations,
  };
}

function operationStubs(overrides: Record<string, unknown> = {}): PromotionOperations {
  return {
    resolveProject: vi.fn().mockResolvedValue({
      outcome: 'exact_match',
      matched_on: 'repository_slug',
      project: {
        id: 'prj_RESOLVED01',
        name: 'Memento',
        description: 'Memory layer',
        status: 'active',
      },
      suggestions: [],
    }),
    assertProjectsRegistered: vi.fn().mockResolvedValue(undefined),
    createMemory: vi.fn(),
    getMemory: vi.fn(),
    updateMemory: vi.fn(),
    ...overrides,
  } as unknown as PromotionOperations;
}

function existingMemory(): MemoryDetail {
  return {
    id: 'mem_EXISTING01',
    title: 'Existing webhook behavior',
    description: 'Existing notes about webhook retries.',
    scope: { kind: 'projects', project_ids: ['prj_RESOLVED01'] },
    type: 'debugging_pattern',
    provenance: {
      source: 'agent_observed',
      verification: 'observed_once',
      evidence: [],
    },
    status: 'active',
    created_at: '2026-07-01T10:00:00Z',
    updated_at: '2026-07-01T10:00:00Z',
    body: 'Existing webhook retry notes.',
    projects: [{ id: 'prj_RESOLVED01', name: 'Memento' }],
  };
}

function fixture(
  kind: 'search' | 'write',
  action: 'create' | 'update' = 'create',
  useStoredProjectIds = true,
  successfulActualWrite: boolean | 'error' = false,
  unresolvedProjectScope = false,
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
    events: successfulActualWrite
      ? [
          {
            schemaVersion: 1,
            id: 'event_actual_write',
            sessionId: 'session_1',
            threadId: 'thread_1',
            sequence: 0,
            kind: 'tool_call',
            role: 'assistant',
            actualOperationId: 'op_actual_write',
          },
        ]
      : [],
    actualOperations: successfulActualWrite
      ? [
          {
            schemaVersion: 1,
            id: 'op_actual_write',
            sessionId: 'session_1',
            threadId: 'thread_1',
            callEventId: 'event_actual_write',
            sequence: 0,
            tool: 'create_memory',
            kind: 'write',
            sourceToolName: 'create_memory',
            callId: 'call_actual_write',
            outcome: successfulActualWrite === 'error' ? 'error' : 'success',
          },
        ]
      : [],
    policyVersion: 'unknown',
    projectContext: useStoredProjectIds
      ? {
          workingDirectory: '<path:redacted>',
          projectIds: ['prj_RESOLVED01'],
        }
      : { repositorySlug: 'destiner/memento' },
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
      reason: 'Task started.',
      context: {},
    });
  }
  const payload = (kind === 'search'
    ? {
        kind: 'search',
        checkpointId: 'checkpoint_1',
        search: { query: 'webhook retries', scope: { kind: 'global' } },
        rationale: 'Look for prior experience.',
      }
    : {
        kind: 'capture',
        taskId: 'task_1',
        action,
        targetMemoryId: action === 'update' ? 'mem_EXISTING01' : null,
        memory: {
          title: 'Webhook retries duplicate sends',
          description: 'Peak delays make retries appear duplicated.',
          scope: unresolvedProjectScope
            ? { kind: 'unresolved_projects' }
            : {
                kind: 'projects',
                project_ids: [useStoredProjectIds ? 'prj_RESOLVED01' : 'prj_PROPOSED01'],
              },
          type: 'debugging_pattern',
          body: 'Webhook delivery timestamps identify delayed retries.',
          provenance: { source: 'agent_observed' },
        },
        rationale: 'The root cause is durable and absent from the repository.',
      }) as unknown as JsonValue;
  const proposalId = store.insertProposal({
    runId: 'run_1',
    taskId: 'task_1',
    ...(kind === 'search' ? { checkpointId: 'checkpoint_1' } : {}),
    ordinal: 0,
    kind: kind === 'search' ? 'search' : action,
    payload,
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
    ...(successfulActualWrite ? { actualOperationId: 'op_actual_write' } : {}),
    label: successfulActualWrite ? 'timely' : 'missed',
    explanation: 'The operation did not occur.',
  });
  return { store, comparisonId };
}

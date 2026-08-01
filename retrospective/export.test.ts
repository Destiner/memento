import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { RetrospectiveStore } from './db/store.js';
import { buildRegressionCases, exportRegressionJsonl } from './export.js';

describe('regression export', () => {
  const temporaryDirectories: string[] = [];

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('exports reviewed cases only and strips raw source and working paths', async () => {
    const store = fixture();
    const cases = buildRegressionCases(store, 'run_1');
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      expected: { label: 'missed', decision: 'approved', reviewerAction: 'approve' },
    });
    expect(JSON.stringify(cases)).not.toContain('/Users/timur/private');
    expect(JSON.stringify(cases)).not.toContain('history.jsonl');
    expect(JSON.stringify(cases)).not.toContain('supersecret');
    expect(JSON.stringify(cases)).toContain('[REDACTED:SECRET]');

    const directory = mkdtempSync(join(tmpdir(), 'memento-export-'));
    temporaryDirectories.push(directory);
    const output = join(directory, 'nested', 'regressions.jsonl');
    const result = await exportRegressionJsonl(store, 'run_1', output);
    expect(result).toEqual({ path: output, cases: 1 });
    const lines = readFileSync(output, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
    store.close();
  });
});

function fixture(): RetrospectiveStore {
  const store = new RetrospectiveStore(':memory:', () => new Date('2026-08-01T10:00:00Z'));
  store.createRun({ id: 'run_1', sourcePolicyVersion: 'unknown', pipelineVersion: '1' });
  store.ingestSourceReferences('run_1', [
    {
      sourceId: 'source_1',
      client: 'codex',
      path: '/Users/timur/private/history.jsonl',
      contentSha256: 'a'.repeat(64),
    },
  ]);
  store.ingestSession('run_1', {
    schemaVersion: 1,
    id: 'session_1',
    client: 'codex',
    sourceSessionIds: ['source-session'],
    sourceIds: ['source_1'],
    rootThreadId: 'thread_1',
    threads: [{ id: 'thread_1', sourceSessionId: 'source-session' }],
    events: [],
    actualOperations: [],
    policyVersion: 'unknown',
    projectContext: { workingDirectory: '/Users/timur/private/project' },
    warnings: [],
  });
  store.insertTask({
    runId: 'run_1',
    id: 'task_1',
    sessionId: 'session_1',
    ordinal: 0,
    startSequence: 0,
    endSequence: 0,
    summary: 'Investigated a recurring webhook issue with TOKEN=supersecret.',
  });
  store.insertCheckpoint({
    runId: 'run_1',
    id: 'checkpoint_1',
    taskId: 'task_1',
    ordinal: 0,
    afterSequence: 0,
    reason: 'Task started.',
    context: {
      projectContext: { workingDirectory: '/Users/timur/private/project' },
      events: [{ text: 'Opened /Users/timur/private/project/config.ts' }],
    },
  });
  const proposalId = store.insertProposal({
    id: 'proposal_reviewed',
    runId: 'run_1',
    taskId: 'task_1',
    checkpointId: 'checkpoint_1',
    ordinal: 0,
    kind: 'search',
    payload: {
      kind: 'search',
      checkpointId: 'checkpoint_1',
      search: { query: 'webhook retries', scope: { kind: 'global' } },
      rationale: 'Look for prior experience.',
    },
    evaluator: {
      provider: 'codex',
      model: 'test',
      promptVersion: '1',
      schemaVersion: '1',
    },
  });
  store.insertComparison({
    id: 'comparison_reviewed',
    runId: 'run_1',
    taskId: 'task_1',
    kind: 'search',
    proposalId,
    label: 'missed',
    explanation: 'No search occurred.',
  });
  store.recordReview('comparison_reviewed', { action: 'approve', actor: 'timur' });
  store.insertComparison({
    id: 'comparison_pending',
    runId: 'run_1',
    taskId: 'task_1',
    kind: 'search',
    proposalId: store.insertProposal({
      id: 'proposal_pending',
      runId: 'run_1',
      taskId: 'task_1',
      checkpointId: 'checkpoint_1',
      ordinal: 1,
      kind: 'search',
      payload: { query: 'pending' },
      evaluator: {
        provider: 'codex',
        model: 'test',
        promptVersion: '1',
        schemaVersion: '1',
      },
    }),
    label: 'ambiguous',
    explanation: 'Needs review.',
  });
  return store;
}

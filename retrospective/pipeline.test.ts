import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolvePaths } from '../src/config.js';
import { RetrospectiveStore } from './db/store.js';
import type { EvaluationRequest, EvaluationResult, Evaluator } from './evaluator/types.js';
import { exportRegressionJsonl } from './export.js';
import { runRetrospective } from './pipeline.js';
import { promoteApprovedWriteFromHome } from './promote.js';
import { buildReviewedReport } from './report.js';
import { applyReview } from './review.js';

describe('runRetrospective', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('runs from history through review, promotion, report, and regression export', async () => {
    const root = await temporaryDirectory();
    const sourcePath = join(root, 'codex.jsonl');
    await writeFile(
      sourcePath,
      [
        JSON.stringify({
          timestamp: '2026-08-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'session-one', session_id: 'session-one', cwd: join(root, 'repo') },
        }),
        JSON.stringify({
          timestamp: '2026-08-01T10:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Debug the recurring checkout failure.' },
        }),
        JSON.stringify({
          timestamp: '2026-08-01T10:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'The durable cause is an expired lease.' },
        }),
      ].join('\n'),
    );

    const evaluator = new FixtureEvaluator();
    const store = new RetrospectiveStore();
    const options = {
      store,
      paths: resolvePaths(join(root, 'memento-home')),
      sources: [{ id: 'src_fixture', client: 'codex' as const, path: sourcePath }],
      telemetryEvents: [],
      evaluator,
      maxTasks: 1,
    };

    const first = await runRetrospective(options);
    const callsAfterFirstRun = evaluator.calls;
    const second = await runRetrospective(options);

    expect(first).toMatchObject({
      status: 'evaluated',
      sessionCount: 1,
      selectedTaskCount: 1,
      analyzedTaskCount: 1,
      reusedCompletedRun: false,
    });
    expect(second).toMatchObject({
      runId: first.runId,
      status: 'evaluated',
      reusedCompletedRun: true,
    });
    expect(evaluator.calls).toBe(callsAfterFirstRun);
    expect(store.listReviewQueue(first.runId)).toHaveLength(2);
    expect(store.counts()).toMatchObject({ source_references: 1, sessions: 1, tasks: 1 });
    expect(store.getRun(first.runId)?.sourcePolicyVersion).toBe('unknown');

    const queue = store.listReviewQueue(first.runId);
    const search = queue.find((item) => item.kind === 'search');
    const write = queue.find((item) => item.kind === 'write');
    expect(search).toBeDefined();
    expect(write).toBeDefined();
    applyReview(store, search!.id, { action: 'approve', actor: 'test-reviewer' });
    applyReview(store, write!.id, { action: 'approve', actor: 'test-reviewer' });

    const promotion = await promoteApprovedWriteFromHome(store, write!.id, options.paths.home);
    expect(promotion).toMatchObject({ status: 'succeeded', promotedMemoryId: expect.any(String) });
    expect(await readdir(options.paths.memories)).toHaveLength(1);

    const report = buildReviewedReport(store, first.runId);
    expect(report).toMatchObject({ reviewed: 2, unreviewedExcluded: 0 });

    const exportPath = join(root, 'exports', 'reviewed.jsonl');
    const exported = await exportRegressionJsonl(store, first.runId, exportPath);
    expect(exported).toEqual({ path: exportPath, cases: 2 });
    const exportedText = await readFile(exportPath, 'utf8');
    expect(exportedText).not.toContain(sourcePath);
    const exportedCases = exportedText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { kind: string; context?: { events?: unknown[] } });
    expect(exportedCases).toHaveLength(2);
    expect(
      exportedCases.find((item) => item.kind === 'write')?.context?.events?.length,
    ).toBeGreaterThan(0);
    store.close();
  });

  it('records a failed task, redacts its diagnostic, and continues with later tasks', async () => {
    const root = await temporaryDirectory();
    const sourcePath = join(root, 'two-tasks.jsonl');
    await writeFile(
      sourcePath,
      [
        JSON.stringify({
          timestamp: '2026-08-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'session-two', session_id: 'session-two', cwd: join(root, 'repo') },
        }),
        JSON.stringify({
          timestamp: '2026-08-01T10:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'FIRST_FAIL investigate one.' },
        }),
        JSON.stringify({
          timestamp: '2026-08-01T10:00:02.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'First task ended.' },
        }),
        JSON.stringify({
          timestamp: '2026-08-01T10:00:03.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Investigate the independent second issue.' },
        }),
        JSON.stringify({
          timestamp: '2026-08-01T10:00:04.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Second task ended.' },
        }),
      ].join('\n'),
    );
    const store = new RetrospectiveStore();
    const result = await runRetrospective({
      store,
      paths: resolvePaths(join(root, 'memento-home')),
      sources: [{ id: 'src_two_tasks', client: 'codex', path: sourcePath }],
      telemetryEvents: [],
      evaluator: new FailingTaskEvaluator(),
      maxTasks: 2,
    });

    expect(result).toMatchObject({
      status: 'complete',
      selectedTaskCount: 2,
      analyzedTaskCount: 1,
      failedTaskCount: 1,
    });
    const failures = store.listTaskFailures(result.runId);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.error).toContain('[REDACTED:PATH]');
    expect(failures[0]?.error).toContain('[REDACTED:SECRET]');
    expect(failures[0]?.error).not.toContain('/Users/alice/private');
    expect(store.counts()).toMatchObject({ tasks: 1, task_failures: 1 });
    store.close();
  });

  it('derives a new run id when the evaluator CLI version changes', async () => {
    const root = await temporaryDirectory();
    const sourcePath = join(root, 'codex.jsonl');
    await writeFile(
      sourcePath,
      [
        JSON.stringify({
          timestamp: '2026-08-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'session-version', session_id: 'session-version' },
        }),
        JSON.stringify({
          timestamp: '2026-08-01T10:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Check evaluator identity.' },
        }),
      ].join('\n'),
    );
    const store = new RetrospectiveStore();
    const base = {
      store,
      paths: resolvePaths(join(root, 'memento-home')),
      sources: [{ id: 'src_version', client: 'codex' as const, path: sourcePath }],
      telemetryEvents: [],
      maxTasks: 1,
    };

    const first = await runRetrospective({ ...base, evaluator: new FixtureEvaluator('1.0.0') });
    const second = await runRetrospective({ ...base, evaluator: new FixtureEvaluator('1.1.0') });

    expect(first.runId).not.toBe(second.runId);
    expect(store.getRun(first.runId)?.evaluator?.cliVersion).toBe('1.0.0');
    expect(store.getRun(second.runId)?.evaluator?.cliVersion).toBe('1.1.0');
    store.close();
  });

  it('analyzes Claude Code and Codex histories together through the shared pipeline', async () => {
    const root = await temporaryDirectory();
    const claudePath = join(root, 'claude.jsonl');
    const codexPath = join(root, 'codex.jsonl');
    await writeFile(
      claudePath,
      [
        JSON.stringify({
          type: 'user',
          sessionId: 'claude-shared',
          timestamp: '2026-08-01T09:00:00.000Z',
          message: { content: 'Investigate the Claude Code task.' },
        }),
        JSON.stringify({
          type: 'assistant',
          sessionId: 'claude-shared',
          timestamp: '2026-08-01T09:00:01.000Z',
          message: {
            model: 'claude-test',
            content: [{ type: 'text', text: 'Claude Code task complete.' }],
          },
        }),
      ].join('\n'),
    );
    await writeFile(
      codexPath,
      [
        JSON.stringify({
          timestamp: '2026-08-01T10:00:00.000Z',
          type: 'session_meta',
          payload: { id: 'codex-shared', session_id: 'codex-shared' },
        }),
        JSON.stringify({
          timestamp: '2026-08-01T10:00:01.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: 'Investigate the Codex task.' },
        }),
      ].join('\n'),
    );
    const store = new RetrospectiveStore();
    const result = await runRetrospective({
      store,
      paths: resolvePaths(join(root, 'memento-home')),
      sources: [
        { id: 'src_claude_shared', client: 'claude-code', path: claudePath },
        { id: 'src_codex_shared', client: 'codex', path: codexPath },
      ],
      telemetryEvents: [],
      evaluator: new FailingTaskEvaluator(),
      maxTasks: 2,
    });

    expect(result).toMatchObject({
      sessionCount: 2,
      selectedTaskCount: 2,
      analyzedTaskCount: 2,
      failedTaskCount: 0,
    });
    expect(
      store
        .query<{ client: string }>(
          'SELECT client FROM sessions WHERE run_id = ? ORDER BY client',
          result.runId,
        )
        .map((row) => row.client),
    ).toEqual(['claude-code', 'codex']);
    store.close();
  });

  async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'memento-retrospective-pipeline-'));
    temporaryDirectories.push(path);
    return path;
  }
});

class FixtureEvaluator implements Evaluator {
  readonly provider = 'codex' as const;
  readonly model = 'fixture-model';
  calls = 0;

  constructor(private readonly cliVersion = 'fixture') {}

  async identity() {
    return {
      provider: this.provider,
      cli: 'codex' as const,
      cliVersion: this.cliVersion,
      model: this.model,
    };
  }

  async evaluate<Output>(request: EvaluationRequest<Output>): Promise<EvaluationResult<Output>> {
    this.calls += 1;
    let output: unknown;
    if (request.prompt.startsWith('Select meaningful moments')) {
      output = { checkpoints: [] };
    } else if (request.prompt.startsWith('Decide whether')) {
      const checkpointId = /Checkpoint id: (.+)/.exec(request.prompt)?.[1];
      output = {
        proposals: [
          {
            kind: 'search',
            checkpointId,
            search: {
              query: 'recurring checkout failure',
              scope: { kind: 'global' },
              intent: 'Recall an established debugging pattern.',
            },
            rationale: 'The failure is explicitly recurring.',
          },
        ],
      };
    } else {
      const taskId = /Task id: (.+)/.exec(request.prompt)?.[1];
      output = {
        summary: 'Found that expired leases cause the recurring checkout failure.',
        proposals: [
          {
            kind: 'capture',
            taskId,
            action: 'create',
            targetMemoryId: null,
            memory: {
              title: 'Expired leases cause checkout failures',
              description: 'A recurring checkout failure is caused by an expired lease.',
              scope: { kind: 'global' },
              type: 'debugging_pattern',
              body: 'Renew the lease before retrying the checkout.',
              provenance: { source: 'agent_observed', verification: 'observed_once' },
            },
            rationale: 'The root cause is durable and affects future debugging.',
          },
        ],
      };
    }
    return {
      output: request.outputSchema.parse(output),
      run: {
        provider: this.provider,
        cli: 'codex',
        cliVersion: this.cliVersion,
        model: this.model,
        promptVersion: request.promptVersion,
        schemaVersion: request.schemaVersion,
        policyVersion: '2.1.0',
      },
    };
  }
}

class FailingTaskEvaluator extends FixtureEvaluator {
  override async evaluate<Output>(
    request: EvaluationRequest<Output>,
  ): Promise<EvaluationResult<Output>> {
    if (request.prompt.includes('FIRST_FAIL')) {
      throw new Error('TOKEN=supersecret failed at /Users/alice/private/repo');
    }

    const candidates: unknown[] = [
      { checkpoints: [] },
      { proposals: [] },
      { summary: 'The second task completed without a durable finding.', proposals: [] },
    ];
    const output = candidates.find(
      (candidate) => request.outputSchema.safeParse(candidate).success,
    );
    if (output === undefined) throw new Error('No fixture output matched the evaluator schema.');
    return {
      output: request.outputSchema.parse(output),
      run: {
        provider: this.provider,
        cli: 'codex',
        cliVersion: 'fixture',
        model: this.model,
        promptVersion: request.promptVersion,
        schemaVersion: request.schemaVersion,
        policyVersion: '2.1.0',
      },
    };
  }
}

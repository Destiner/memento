import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { parseHistorySource, runCli } from './cli.js';
import type { ReviewQueueItem } from './db/types.js';
import type { RegressionCase } from './export.js';
import type { RunRetrospectiveResult } from './pipeline.js';
import type { ReviewedReport } from './report.js';

const cliLifecycleCases = [
  { client: 'claude-code', evaluator: 'claude-code', executable: 'claude' },
  { client: 'codex', evaluator: 'codex', executable: 'codex' },
] as const;

describe('retrospective CLI', () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it('parses explicit client-qualified history sources', () => {
    const source = parseHistorySource('claude-code:fixtures/history.jsonl');
    expect(source).toMatchObject({
      client: 'claude-code',
      path: resolve('fixtures/history.jsonl'),
    });
    expect(source.id).toMatch(/^src_[a-f0-9]{24}$/);
    expect(() => parseHistorySource('fixtures/history.jsonl')).toThrow(/expected/);
  });

  it('refuses remote evaluation without the explicit cost and privacy gate', async () => {
    const home = await temporaryDirectory();
    await expect(
      runCli([
        'run',
        '--home',
        home,
        '--source',
        'codex:history.jsonl',
        '--evaluator',
        'codex',
        '--model',
        'test-model',
      ]),
    ).rejects.toThrow(/--allow-remote/);
  });

  it('renders help without requiring command configuration', async () => {
    const output: string[] = [];
    await runCli(['help'], { stdout: (value) => output.push(value) });
    expect(output.join('\n')).toContain('claude-code');
    expect(output.join('\n')).toContain('codex');
  });

  it('rejects review options that do not apply to the selected action', async () => {
    const home = await temporaryDirectory();
    await expect(
      runCli([
        'review',
        'comparison_missing',
        'approve',
        '--home',
        home,
        '--actor',
        'timur',
        '--label',
        'missed',
      ]),
    ).rejects.toThrow(/Unknown option.*--label/);
  });

  it.each(cliLifecycleCases)(
    'runs $client history end to end through the $executable evaluator adapter',
    async ({ client, evaluator, executable }) => {
      const root = await temporaryDirectory();
      const home = join(root, 'memento-home');
      const sourcePath = join(root, `${client}-history.jsonl`);
      const exportPath = join(root, 'exports', `${client}.jsonl`);
      const binDirectory = join(root, 'bin');
      await writeFile(sourcePath, historyFixture(client));
      await installEvaluatorStubs(binDirectory);

      const originalPath = process.env.PATH;
      process.env.PATH = [binDirectory, originalPath].filter(Boolean).join(delimiter);
      try {
        const run = await runJson<RunRetrospectiveResult>([
          'run',
          '--home',
          home,
          '--source',
          `${client}:${sourcePath}`,
          '--evaluator',
          evaluator,
          '--model',
          'offline-fixture-model',
          '--allow-remote',
          '--source-policy-version',
          'offline-lifecycle-fixture',
          '--run-salt',
          `${client}-cli-lifecycle`,
        ]);
        expect(run).toMatchObject({
          status: 'evaluated',
          sessionCount: 1,
          selectedTaskCount: 1,
          analyzedTaskCount: 1,
          failedTaskCount: 0,
        });

        const queue = await runJson<ReviewQueueItem[]>([
          'queue',
          run.runId,
          '--home',
          home,
          '--json',
        ]);
        expect(queue).toHaveLength(1);
        const write = queue[0]!;
        expect(write).toMatchObject({ kind: 'write', label: 'missed', state: 'pending' });

        const review = await runJson<{ pending: number; runStatus: string }>([
          'review',
          write.id,
          'approve',
          '--home',
          home,
          '--actor',
          'offline-test-reviewer',
        ]);
        expect(review).toMatchObject({ pending: 0, runStatus: 'reviewing' });

        const promotion = await runJson<{
          status: string;
          promotedMemoryId?: string;
          runStatus: string;
        }>(['promote', write.id, '--home', home]);
        expect(promotion).toMatchObject({
          status: 'succeeded',
          promotedMemoryId: expect.any(String),
          runStatus: 'complete',
        });

        const memoryFiles = await readdir(join(home, 'memories'));
        expect(memoryFiles).toHaveLength(1);
        const promotedMemory = await readFile(join(home, 'memories', memoryFiles[0]!), 'utf8');
        expect(promotedMemory).toContain(`${executable} evaluator lifecycle finding`);
        expect(promotedMemory).toContain(promotion.promotedMemoryId!);

        const report = await runJson<ReviewedReport>([
          'report',
          run.runId,
          '--home',
          home,
          '--json',
        ]);
        expect(report).toMatchObject({
          reviewed: 1,
          unreviewedExcluded: 0,
          byKind: { search: 0, write: 1 },
          byDecision: { approved: 1, rejected: 0, duplicate: 0 },
          promotion: { approvedWrites: 1, notAttempted: 0, byStatus: { succeeded: 1 } },
          run: {
            status: 'complete',
            evaluator: {
              provider: evaluator,
              cli: executable,
              cliVersion: '99.1.2',
              model: 'offline-fixture-model',
            },
          },
        });

        const exported = await runJson<{ path: string; cases: number }>([
          'export',
          run.runId,
          '--home',
          home,
          '--output',
          exportPath,
        ]);
        expect(exported).toEqual({ path: exportPath, cases: 1 });
        const regression = JSON.parse(
          (await readFile(exportPath, 'utf8')).trim(),
        ) as RegressionCase;
        expect(regression).toMatchObject({
          client,
          kind: 'write',
          evaluator: {
            provider: evaluator,
            cli: executable,
            cliVersion: '99.1.2',
            model: 'offline-fixture-model',
          },
          expected: { label: 'missed', decision: 'approved', reviewerAction: 'approve' },
        });
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
  );

  async function temporaryDirectory(): Promise<string> {
    const path = await mkdtemp(join(tmpdir(), 'memento-retrospective-cli-'));
    temporaryDirectories.push(path);
    return path;
  }
});

async function runJson<T>(argv: string[]): Promise<T> {
  const output: string[] = [];
  await runCli(argv, { stdout: (value) => output.push(value) });
  expect(output).toHaveLength(1);
  return JSON.parse(output[0]!) as T;
}

function historyFixture(client: (typeof cliLifecycleCases)[number]['client']): string {
  if (client === 'claude-code') {
    return [
      JSON.stringify({
        type: 'user',
        sessionId: 'claude-cli-lifecycle',
        timestamp: '2026-08-01T09:00:00.000Z',
        message: { content: 'Diagnose the recurring offline fixture failure.' },
      }),
      JSON.stringify({
        type: 'assistant',
        sessionId: 'claude-cli-lifecycle',
        timestamp: '2026-08-01T09:00:01.000Z',
        message: {
          model: 'claude-fixture',
          content: [{ type: 'text', text: 'The durable cause is the evaluator adapter.' }],
        },
      }),
    ].join('\n');
  }

  return [
    JSON.stringify({
      timestamp: '2026-08-01T10:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'codex-cli-lifecycle', session_id: 'codex-cli-lifecycle' },
    }),
    JSON.stringify({
      timestamp: '2026-08-01T10:00:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: 'Diagnose the recurring offline fixture failure.' },
    }),
    JSON.stringify({
      timestamp: '2026-08-01T10:00:02.000Z',
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'The durable cause is the evaluator adapter.' },
    }),
  ].join('\n');
}

async function installEvaluatorStubs(binDirectory: string): Promise<void> {
  const script = `#!/usr/bin/env node
const { basename } = require('node:path');

const executable = basename(process.argv[1]);
if (process.argv.includes('--version')) {
  process.stdout.write(executable + ' 99.1.2\\n');
} else {
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    prompt += chunk;
  });
  process.stdin.on('end', () => {
    let output;
    if (prompt.startsWith('Select meaningful moments')) {
      output = { checkpoints: [] };
    } else if (prompt.startsWith('Decide whether')) {
      output = { proposals: [] };
    } else if (prompt.startsWith('Summarize this completed coding task')) {
      const taskId = /^Task id: (.+)$/m.exec(prompt)?.[1];
      if (taskId === undefined) throw new Error('capture prompt has no task id');
      output = {
        summary: 'The offline lifecycle fixture established a durable evaluator adapter finding.',
        proposals: [
          {
            kind: 'capture',
            taskId,
            action: 'create',
            targetMemoryId: null,
            memory: {
              title: executable + ' evaluator lifecycle finding',
              description: 'The evaluator adapter can produce a promotable retrospective capture.',
              scope: { kind: 'global' },
              type: 'environment_workflow_quirk',
              body: 'Use the structured CLI evaluator adapter when running retrospective analysis.',
              provenance: { source: 'agent_observed', verification: 'observed_once' },
            },
            rationale: 'The finding is reusable across retrospective runs.',
          },
        ],
      };
    } else {
      throw new Error('unrecognized evaluator prompt');
    }

    if (executable === 'claude') {
      process.stdout.write(JSON.stringify({ structured_output: output }) + '\\n');
    } else {
      process.stdout.write(
        JSON.stringify({
          type: 'item.completed',
          item: { type: 'agent_message', text: JSON.stringify(output) },
        }) + '\\n',
      );
    }
  });
}
`;
  await mkdir(binDirectory, { recursive: true });
  await Promise.all([
    writeFile(join(binDirectory, 'claude'), script, { mode: 0o755 }),
    writeFile(join(binDirectory, 'codex'), script, { mode: 0o755 }),
  ]);
}

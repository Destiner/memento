import { describe, expect, test } from 'vitest';

import { type Config } from './config.js';
import { type Cell } from './plan.js';
import { buildRecord, UNSCORED, type RepStatus } from './record.js';
import { type Scenario } from './scenario.js';
import { executeCells, type RepOutcome, type RunCell } from './run.js';

const CONFIG: Config = {
  name: 'baseline-0',
  knob: 'none',
  variant: 'none',
  side: 'both',
  portability: 'portable',
  memento_variant: 'plain',
};

const SCENARIO: Scenario = {
  id: 'read/mini',
  version: 1,
  class: 'should-retrieve',
  fixture: 'fixtures/mini',
  task: 'do it',
  corpus: 'corpus/mini',
  seeded_memory: 'facts/planted.md',
  checks: { utility_regex: '(?i)x' },
};

function makeCells(n: number): Cell[] {
  return Array.from({ length: n }, (_, i) => ({ config: CONFIG, scenario: SCENARIO, rep: i + 1 }));
}

function outcome(cell: Cell, status: RepStatus, costUsd: number): RepOutcome {
  const record = buildRecord({
    run: 'test',
    timestamp: '2026-07-07T00:00:00Z',
    model: 'm',
    ccVersion: 'x',
    mementoVersion: 'y',
    env: 'clean',
    cell,
    configHash: 'sha256:x',
    status,
    session: { cost_usd: costUsd, duration_s: 1, turns: 1, tokens_in: 1, tokens_out: 1 },
    scored: UNSCORED,
    transcriptPath: 't',
  });
  return { status, costUsd, record };
}

const OPTS = { concurrency: 1, maxSpendUsd: 1000, retries: 1 };

describe('executeCells', () => {
  test('runs every cell and records one per rep when under the cap', async () => {
    const cells = makeCells(4);
    const records: string[] = [];
    const runCell: RunCell = (cell) => Promise.resolve(outcome(cell, 'ok', 1));
    const summary = await executeCells(cells, { ...OPTS, concurrency: 2 }, runCell, (r) =>
      records.push(`${r.config}#${r.rep}`),
    );
    expect(summary).toMatchObject({ launched: 4, ok: 4, invalid: 0, halted: false, spentUsd: 4 });
    expect(records).toHaveLength(4);
  });

  test('halts at the spend cap, finishing no further reps (concurrency 1)', async () => {
    const cells = makeCells(5);
    const runCell: RunCell = (cell) => Promise.resolve(outcome(cell, 'ok', 10));
    const summary = await executeCells(cells, { ...OPTS, maxSpendUsd: 25 }, runCell, () => {});
    // 10+10+10 = 30 ≥ 25 after the third, so the fourth is never launched.
    expect(summary.launched).toBe(3);
    expect(summary.halted).toBe(true);
    expect(summary.spentUsd).toBe(30);
  });

  test('retries an invalid rep once and records the recovered attempt', async () => {
    const cells = makeCells(1);
    const attempts: number[] = [];
    const runCell: RunCell = (cell, attempt) => {
      attempts.push(attempt);
      return Promise.resolve(outcome(cell, attempt === 1 ? 'invalid' : 'ok', 2));
    };
    const records: RepStatus[] = [];
    const summary = await executeCells(cells, OPTS, runCell, (r) => records.push(r.status));
    expect(attempts).toEqual([1, 2]);
    expect(summary).toMatchObject({ ok: 1, invalid: 0 });
    expect(summary.spentUsd).toBe(4); // both attempts cost real money
    expect(records).toEqual(['ok']); // one record per rep, the final attempt
  });

  test('records invalid when retries are exhausted', async () => {
    const cells = makeCells(1);
    let calls = 0;
    const runCell: RunCell = (cell) => {
      calls += 1;
      return Promise.resolve(outcome(cell, 'invalid', 1));
    };
    const summary = await executeCells(cells, OPTS, runCell, () => {});
    expect(calls).toBe(2); // attempt 1 + one retry
    expect(summary).toMatchObject({ ok: 0, invalid: 1 });
  });

  test('does not retry when retries is 0', async () => {
    const cells = makeCells(1);
    let calls = 0;
    const runCell: RunCell = (cell) => {
      calls += 1;
      return Promise.resolve(outcome(cell, 'invalid', 1));
    };
    const summary = await executeCells(cells, { ...OPTS, retries: 0 }, runCell, () => {});
    expect(calls).toBe(1);
    expect(summary.invalid).toBe(1);
  });
});

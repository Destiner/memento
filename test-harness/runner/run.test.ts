import { describe, expect, test } from 'vitest';

import { type Config } from './config.js';
import { type Cell } from './plan.js';
import { buildRecord, UNSCORED, type RepStatus, type ResultRecord } from './record.js';
import { type Scenario } from './scenario.js';
import {
  accountedCostUsd,
  costFieldMissing,
  executeCells,
  type RepOutcome,
  type RunCell,
} from './run.js';
import { type SessionResult } from './session.js';

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

// Stub halted-record builder for the scheduler; the real one lives in run.ts.
const halted = (cell: Cell): ResultRecord => outcome(cell, 'halted', 0).record;

describe('executeCells', () => {
  test('runs every cell and records one per rep when under the cap', async () => {
    const cells = makeCells(4);
    const records: string[] = [];
    const runCell: RunCell = (cell) => Promise.resolve(outcome(cell, 'ok', 1));
    const summary = await executeCells(
      cells,
      { ...OPTS, concurrency: 2 },
      runCell,
      (r) => records.push(`${r.config}#${r.rep}`),
      halted,
    );
    expect(summary).toMatchObject({ launched: 4, ok: 4, invalid: 0, halted: false, spentUsd: 4 });
    expect(records).toHaveLength(4);
  });

  test('halts at the spend cap, recording the unlaunched cells as halted (concurrency 1)', async () => {
    const cells = makeCells(5);
    const statuses: RepStatus[] = [];
    const runCell: RunCell = (cell) => Promise.resolve(outcome(cell, 'ok', 10));
    const summary = await executeCells(
      cells,
      { ...OPTS, maxSpendUsd: 25 },
      runCell,
      (r) => statuses.push(r.status),
      halted,
    );
    // 10+10+10 = 30 ≥ 25 after the third, so the last two are never launched...
    expect(summary.launched).toBe(3);
    expect(summary.halted).toBe(true);
    expect(summary.skipped).toBe(2);
    expect(summary.spentUsd).toBe(30);
    // ...but they are recorded as halted, so the matrix isn't silently short (§8.2).
    expect(statuses).toEqual(['ok', 'ok', 'ok', 'halted', 'halted']);
  });

  test('a run that lands spend exactly on the cap with its last cell is not halted', async () => {
    // Regression: the cap check must follow cell exhaustion, or a completed run
    // that hit the cap on the final cell would be misreported as halted (§7.4).
    const cells = makeCells(3);
    const runCell: RunCell = (cell) => Promise.resolve(outcome(cell, 'ok', 10));
    const summary = await executeCells(
      cells,
      { ...OPTS, maxSpendUsd: 30 },
      runCell,
      () => {},
      halted,
    );
    expect(summary).toMatchObject({ launched: 3, halted: false, skipped: 0, spentUsd: 30 });
  });

  test('retries an invalid rep once and records the recovered attempt', async () => {
    const cells = makeCells(1);
    const attempts: number[] = [];
    const runCell: RunCell = (cell, attempt) => {
      attempts.push(attempt);
      return Promise.resolve(outcome(cell, attempt === 1 ? 'invalid' : 'ok', 2));
    };
    const records: RepStatus[] = [];
    const summary = await executeCells(cells, OPTS, runCell, (r) => records.push(r.status), halted);
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
    const summary = await executeCells(cells, OPTS, runCell, () => {}, halted);
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
    const summary = await executeCells(cells, { ...OPTS, retries: 0 }, runCell, () => {}, halted);
    expect(calls).toBe(1);
    expect(summary.invalid).toBe(1);
  });

  test('does not retry an invalid rep once the spend cap is exhausted', async () => {
    // Regression (§7.4): a config that times out every rep must not retry past the
    // cap. The first attempt alone already meets the cap, so no retry is launched.
    const cells = makeCells(1);
    let calls = 0;
    const runCell: RunCell = (cell) => {
      calls += 1;
      return Promise.resolve(outcome(cell, 'invalid', 10));
    };
    const summary = await executeCells(
      cells,
      { ...OPTS, maxSpendUsd: 5 },
      runCell,
      () => {},
      halted,
    );
    expect(calls).toBe(1); // no retry despite retries: 1
    expect(summary.invalid).toBe(1);
    expect(summary.spentUsd).toBe(10);
  });
});

function session(over: Partial<SessionResult>): SessionResult {
  return {
    parsed: true,
    isError: false,
    costUsd: 0.5,
    durationS: 1,
    turns: 1,
    tokensIn: 1,
    tokensOut: 1,
    sessionId: 's',
    resultText: 'r',
    ...over,
  };
}

describe('accountedCostUsd', () => {
  test('charges the measured cost when Claude Code reported one', () => {
    expect(accountedCostUsd(session({ costUsd: 0.42 }), 2)).toBe(0.42);
  });

  test('charges the fallback when a timed-out/crashed session reported none', () => {
    expect(accountedCostUsd(session({ parsed: false, isError: true, costUsd: null }), 2)).toBe(2);
  });
});

describe('costFieldMissing', () => {
  test('flags a completed session carrying no cost (schema drift)', () => {
    expect(costFieldMissing(session({ costUsd: null }))).toBe(true);
  });

  test('does not flag a timed-out/crashed session — a null cost is expected there', () => {
    expect(costFieldMissing(session({ parsed: false, isError: true, costUsd: null }))).toBe(false);
  });

  test('does not flag a normal costed session', () => {
    expect(costFieldMissing(session({ costUsd: 0.5 }))).toBe(false);
  });
});

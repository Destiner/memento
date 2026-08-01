import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { type MementoCall } from './event-log.js';
import { type RawFacts, type RepStatus, type ResultRecord } from './record.js';
import {
  aggregate,
  buildClassMap,
  DEFAULT_OPTIONS,
  parseResults,
  renderReport,
  type ScoreOptions,
  type ScenarioClass,
} from './report.js';

const HARNESS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const EMPTY_CLASSES = new Map<string, ScenarioClass>();

const call = (
  input: Pick<MementoCall, 'tool' | 'outcome'> & Partial<MementoCall>,
): MementoCall => ({
  session_id: 'ses_TEST',
  server_version: '0.3.2',
  policy_version: '2.1.0',
  variant: 'shipped-v2',
  log_schema_version: 2,
  ...input,
});

// A record builder with sane defaults; overrides target the fields a test cares
// about. Class is inferred from the scenario id prefix + scored fields (the report
// falls back to that when a class map is empty), so tests stay off disk.
function record(over: {
  config: string;
  scenario: string;
  status?: RepStatus;
  raw?: Partial<RawFacts>;
  model?: string;
  cc_version?: string;
  policy_version?: string;
  env?: string;
  scenario_version?: number;
  scenario_class?: ScenarioClass;
}): ResultRecord {
  const raw: RawFacts = {
    memento_calls: [],
    utility_pass: null,
    task_success: true,
    capture: null,
    tokens_in: 1000,
    tokens_out: 500,
    cost_usd: 0.4,
    duration_s: 120,
    turns: 8,
    ...over.raw,
  };
  return {
    run: 'r',
    timestamp: '2026-07-07T10:00:00Z',
    config: over.config,
    config_hash: 'sha256:x',
    scenario: over.scenario,
    scenario_version: over.scenario_version ?? 1,
    ...(over.scenario_class ? { scenario_class: over.scenario_class } : {}),
    rep: 1,
    model: over.model ?? 'claude-opus-4-8',
    cc_version: over.cc_version ?? '1.6.9',
    memento_version: '0.1.0',
    policy_version: over.policy_version ?? '2.1.0',
    env: over.env ?? 'clean',
    status: over.status ?? 'ok',
    raw,
    transcript_path: 't.json',
  };
}

const search = (result_count: number): MementoCall =>
  call({
    tool: 'search_memories',
    outcome: 'success',
    result_count,
    result_ids: result_count > 0 ? ['mem_HIT'] : [],
  });
const readCall = call({ tool: 'get_memory', outcome: 'success', memory_id: 'mem_HIT' });
const createCall = call({
  tool: 'create_memory',
  outcome: 'success',
  result_outcome: 'created',
  memory_id: 'mem_NEW',
});

function only(groups: ReturnType<typeof aggregate>) {
  expect(groups).toHaveLength(1);
  return groups[0]!;
}

function configNamed(group: ReturnType<typeof aggregate>[number], name: string) {
  const found = group.configs.find((c) => c.config === name);
  expect(found, `config ${name}`).toBeDefined();
  return found!;
}

describe('parseResults', () => {
  test('parses valid lines and counts blank/malformed ones', () => {
    const valid = JSON.stringify(record({ config: 'baseline-0', scenario: 'read/x' }));
    const text = `${valid}\n\n{not json}\n{"config":"x"}\n`;
    const { records, malformed } = parseResults(text);
    expect(records).toHaveLength(1);
    expect(malformed).toBe(2); // the non-JSON line and the shape-invalid object
  });
});

describe('aggregate — scores (§5.1)', () => {
  test('read/write scores from the four rates with default λ', () => {
    const records = [
      // utility 1 of 2 = 0.5
      record({ config: 'c', scenario: 'read/a', raw: { utility_pass: true } }),
      record({ config: 'c', scenario: 'read/a', raw: { utility_pass: false } }),
      // read FP: 1 of 2 sessions touched memento = 0.5
      record({ config: 'c', scenario: 'no-read/a', raw: { memento_calls: [search(0)] } }),
      record({ config: 'c', scenario: 'no-read/a', raw: { memento_calls: [] } }),
      // good capture 1 of 2 = 0.5
      record({ config: 'c', scenario: 'write/a', raw: { capture: { passed: true } } }),
      record({ config: 'c', scenario: 'write/a', raw: { capture: { passed: false } } }),
      // capture FP: 1 of 2 attempted a write = 0.5
      record({ config: 'c', scenario: 'no-write/a', raw: { memento_calls: [createCall] } }),
      record({ config: 'c', scenario: 'no-write/a', raw: { memento_calls: [readCall] } }),
    ];
    const group = only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS));
    const c = configNamed(group, 'c');
    expect(c.rates.utility_rate).toBe(0.5);
    expect(c.rates.read_fp_rate).toBe(0.5);
    expect(c.rates.good_capture_rate).toBe(0.5);
    expect(c.rates.capture_fp_rate).toBe(0.5);
    expect(c.rates.read_score).toBeCloseTo(0.5 - 0.33 * 0.5, 6); // 0.335
    expect(c.rates.write_score).toBeCloseTo(0.5 - 1.0 * 0.5, 6); // 0.0
  });

  test('never-touches-memory config scores exactly 0 on both (§5.1 property)', () => {
    const records = [
      record({ config: 'c', scenario: 'read/a', raw: { utility_pass: false, memento_calls: [] } }),
      record({ config: 'c', scenario: 'no-read/a', raw: { memento_calls: [] } }),
      record({ config: 'c', scenario: 'write/a', raw: { capture: { passed: false } } }),
      record({ config: 'c', scenario: 'no-write/a', raw: { memento_calls: [] } }),
    ];
    const c = configNamed(only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS)), 'c');
    expect(c.rates.read_score).toBe(0);
    expect(c.rates.write_score).toBe(0);
  });

  test('a changed λ re-scores from the same log (§8.2)', () => {
    const records = [
      record({ config: 'c', scenario: 'read/a', raw: { utility_pass: true } }),
      record({ config: 'c', scenario: 'no-read/a', raw: { memento_calls: [search(0)] } }),
    ];
    const opts: ScoreOptions = { ...DEFAULT_OPTIONS, lambdaRead: 1.0 };
    const c = configNamed(only(aggregate(records, EMPTY_CLASSES, opts)), 'c');
    expect(c.rates.read_score).toBe(1.0 - 1.0 * 1.0); // 0
  });

  test('a class with no reps yields a null rate, not a zero', () => {
    const records = [record({ config: 'c', scenario: 'read/a', raw: { utility_pass: true } })];
    const c = configNamed(only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS)), 'c');
    expect(c.rates.read_fp_rate).toBeNull(); // no no-read reps
    expect(c.rates.write_score).toBeNull(); // no should-capture reps
    expect(c.rates.read_score).toBe(1.0); // utility 1, no FP penalty available
  });
});

describe('aggregate — guardrails (§5.3)', () => {
  const tok = (tokens_in: number, tokens_out: number): Partial<RawFacts> => ({
    tokens_in,
    tokens_out,
  });

  test('token overhead >15% over the baseline on a no-* scenario disqualifies', () => {
    const records = [
      record({
        config: 'baseline-0',
        scenario: 'no-read/a',
        raw: { ...tok(1000, 0) },
      }),
      record({ config: 'knob', scenario: 'no-read/a', raw: { ...tok(1300, 0) } }), // 1.3×
    ];
    const group = only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS));
    const knob = configNamed(group, 'knob');
    expect(knob.guardrails.token_ratio_max).toBeCloseTo(1.3, 6);
    expect(knob.guardrails.tokens).toBe('fail');
    expect(knob.guardrails.disqualified).toBe(true);
    expect(knob.guardrails.violated).toContain('tokens');
    expect(configNamed(group, 'baseline-0').guardrails.task).toBe('baseline');
  });

  test('task success below baseline − 5pp disqualifies', () => {
    const pass = (n: number, ok: boolean): ResultRecord[] =>
      Array.from({ length: n }, () =>
        record({
          config: ok ? 'baseline-0' : 'knob',
          scenario: 'read/a',
          raw: { utility_pass: true, task_success: ok },
        }),
      );
    // baseline 100% (4/4), knob 0% (0/4): well past the 5pp allowance.
    const records = [...pass(4, true), ...pass(4, false)];
    const knob = configNamed(only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS)), 'knob');
    expect(knob.guardrails.task).toBe('fail');
    expect(knob.guardrails.violated).toContain('task');
  });

  test('within-allowance token bump passes; positive-class overhead is exempt (§5.3 rev)', () => {
    const records = [
      record({
        config: 'baseline-0',
        scenario: 'no-read/a',
        raw: { ...tok(1000, 0) },
      }),
      record({ config: 'knob', scenario: 'no-read/a', raw: { ...tok(1100, 0) } }), // 1.1× on no-read
      // 3× on a POSITIVE class: the product doing its job, not guardrail overhead.
      record({ config: 'knob', scenario: 'read/a', raw: { utility_pass: true, ...tok(3000, 0) } }),
      record({ config: 'baseline-0', scenario: 'read/a', raw: { ...tok(1000, 0) } }),
    ];
    const knob = configNamed(only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS)), 'knob');
    expect(knob.guardrails.tokens).toBe('ok');
    expect(knob.guardrails.disqualified).toBe(false);
  });

  test('no baseline in the group leaves guardrails unevaluated', () => {
    const records = [record({ config: 'knob', scenario: 'read/a', raw: { utility_pass: true } })];
    const group = only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS));
    expect(group.baseline_present).toBe(false);
    expect(configNamed(group, 'knob').guardrails.task).toBe('n/a');
  });
});

describe('aggregate — flake and grouping', () => {
  test('a cell with >30% invalid reps is flagged and excluded from scoring (§7.4)', () => {
    const records = [
      record({ config: 'c', scenario: 'read/a', status: 'ok', raw: { utility_pass: true } }),
      record({
        config: 'c',
        scenario: 'read/a',
        status: 'invalid',
        raw: { utility_pass: null, memento_calls: null },
      }),
      record({
        config: 'c',
        scenario: 'read/a',
        status: 'invalid',
        raw: { utility_pass: null, memento_calls: null },
      }),
    ];
    const group = only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS));
    expect(group.flagged_cells).toHaveLength(1);
    expect(group.flagged_cells[0]).toMatchObject({ config: 'c', scenario: 'read/a', attempts: 3 });
    // Excluded from scoring: the single ok rep does not become a utility_rate of 1.
    const c = configNamed(group, 'c');
    expect(c.rates.utility_rate).toBeNull();
    expect(c.diagnostics.reps_ok).toBe(0);
    expect(c.diagnostics.invalid_rate).toBeCloseTo(2 / 3, 6);
  });

  test('halted cells are recorded, excluded from scoring, and surfaced as incompleteness (§7.4)', () => {
    const records = [
      record({ config: 'knob', scenario: 'read/a', status: 'ok', raw: { utility_pass: true } }),
      record({
        config: 'knob',
        scenario: 'read/b',
        status: 'halted',
        raw: { utility_pass: null, memento_calls: null },
      }),
    ];
    const group = only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS));
    const knob = configNamed(group, 'knob');
    expect(knob.halted_cells).toBe(1);
    // A halted cell is not a completed attempt: it neither flags a cell nor counts
    // toward invalid_rate, and it never enters scoring.
    expect(group.flagged_cells).toHaveLength(0);
    expect(knob.diagnostics.invalid_rate).toBe(0);
    expect(knob.rates.utility_rate).toBe(1); // from the one ok rep only
    const out = renderReport([group], DEFAULT_OPTIONS, { color: false });
    expect(out).toContain('halted at the spend cap');
  });

  test('records split into one group per (model, cc, env)', () => {
    const records = [
      record({ config: 'c', scenario: 'read/a', raw: { utility_pass: true } }),
      record({ config: 'c', scenario: 'read/a', env: 'crowded', raw: { utility_pass: true } }),
    ];
    const groups = aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS);
    expect(groups.map((g) => g.env).sort()).toEqual(['clean', 'crowded']);
  });

  test('records split by instruction policy version', () => {
    const records = [
      record({
        config: 'c',
        scenario: 'read/a',
        policy_version: '2.1.0',
        raw: { utility_pass: true },
      }),
      record({
        config: 'c',
        scenario: 'read/a',
        policy_version: '2.2.0',
        raw: { utility_pass: true },
      }),
    ];
    const groups = aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS);
    expect(groups.map((group) => group.policy_version)).toEqual(['2.1.0', '2.2.0']);
  });

  test('a scenario at two versions in one group is reported as a conflict', () => {
    const records = [
      record({ config: 'c', scenario: 'read/a', scenario_version: 1, raw: { utility_pass: true } }),
      record({ config: 'c', scenario: 'read/a', scenario_version: 2, raw: { utility_pass: true } }),
    ];
    const group = only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS));
    expect(group.version_conflicts).toEqual([{ scenario: 'read/a', versions: [1, 2] }]);
  });
});

describe('aggregate — diagnostics (§5.4)', () => {
  test('per-session call, empty-search, and capture diagnostics', () => {
    const records = [
      record({
        config: 'c',
        scenario: 'read/a',
        raw: { utility_pass: true, memento_calls: [search(3), readCall] },
      }),
      record({
        config: 'c',
        scenario: 'read/a',
        raw: { utility_pass: true, memento_calls: [search(0), createCall] },
      }),
    ];
    const c = configNamed(only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS)), 'c');
    expect(c.diagnostics.mem_calls_per_session).toBe(2); // (2 + 2) / 2
    expect(c.diagnostics.searches_per_session).toBe(1); // one each
    expect(c.diagnostics.empty_search_rate).toBe(0.5); // one of two searches empty
    expect(c.diagnostics.search_to_get_rate).toBe(1); // the one non-empty search was opened
    expect(c.diagnostics.capture_attempts_per_session).toBe(0.5); // one create across two reps
  });
});

describe('classOf — persisted scenario class (§8.2)', () => {
  test('a persisted class survives a rename the disk map and inference both miss', () => {
    // A retired/renamed dir: no scenario.yaml (empty class map), an unmapped group
    // prefix, and no scored class signal — inference alone would drop it to null and
    // it would vanish from the read-FP denominator. Its persisted class rescues it.
    const records = [
      record({
        config: 'c',
        scenario: 'archived/typo',
        scenario_class: 'should-not-retrieve',
        raw: { memento_calls: [search(0)] },
      }),
    ];
    const c = configNamed(only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS)), 'c');
    expect(c.rates.read_fp_rate).toBe(1); // counted, not dropped
  });

  test('falls back to inference when a record carries no persisted class', () => {
    const records = [
      record({ config: 'c', scenario: 'no-read/a', raw: { memento_calls: [search(0)] } }),
    ];
    const c = configNamed(only(aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS)), 'c');
    expect(c.rates.read_fp_rate).toBe(1);
  });
});

describe('buildClassMap', () => {
  test('resolves a real scenario id to its class from disk', () => {
    const map = buildClassMap(HARNESS_ROOT, ['read/email-provider', 'no-write/lowercase-email']);
    expect(map.get('read/email-provider')).toBe('should-retrieve');
    expect(map.get('no-write/lowercase-email')).toBe('should-not-capture');
  });

  test('ignores ids without a scenario.yaml', () => {
    const map = buildClassMap(HARNESS_ROOT, ['read/does-not-exist']);
    expect(map.has('read/does-not-exist')).toBe(false);
  });
});

describe('renderReport', () => {
  const records = [
    record({
      config: 'baseline-0',
      scenario: 'no-read/a',
      raw: { tokens_in: 1000, tokens_out: 0 },
    }),
    record({
      config: 'knob',
      scenario: 'no-read/a',
      raw: { tokens_in: 1400, tokens_out: 0 },
    }),
  ];

  test('renders headers, the group line, and the legend', () => {
    const groups = aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS);
    const out = renderReport(groups, DEFAULT_OPTIONS, { color: false });
    expect(out).toContain('Scores (§5.1)');
    expect(out).toContain('Diagnostics (§5.4)');
    expect(out).toContain('env clean');
    expect(out).toContain('Legend');
    expect(out).toContain('DQ:tokens'); // knob blows the token guardrail
  });

  test('dims disqualified rows only when color is on', () => {
    const groups = aggregate(records, EMPTY_CLASSES, DEFAULT_OPTIONS);
    const withColor = renderReport(groups, DEFAULT_OPTIONS, { color: true });
    const withoutColor = renderReport(groups, DEFAULT_OPTIONS, { color: false });
    expect(withColor).toContain('[2m'); // dim applied to the DQ row
    expect(withoutColor).not.toContain('[2m');
  });

  test('empty input renders a friendly message', () => {
    expect(renderReport([], DEFAULT_OPTIONS, { color: false })).toBe('No records to report.');
  });
});

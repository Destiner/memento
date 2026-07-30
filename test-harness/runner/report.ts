// Report over results.jsonl (harness-spec §5.1, §5.3, §5.4, §8.2, §11.5).
//
// Scores are always recomputed here, never read back as a stored copy: a changed λ
// or a new diagnostic re-scores all history for free (§8.2). This module is the
// pure half — parse the log, recompute read/write scores (§5.1), evaluate the
// guardrails against the baseline (§5.3), derive the diagnostics (§5.4), and render
// a terminal table with guardrail-violating rows dimmed (§8.2). The CLI wiring
// (arg parsing, file I/O, TTY detection) lives in report-cli.ts, mirroring the
// index.ts/run.ts split, so everything below is importable and testable.
//
// Comparisons are only valid within one (model, cc_version, scenario_version)
// tuple (§9), and clean/crowded is a controlled dimension that must also match
// (§3.3) — so records are grouped by (model, cc_version, env) and each group is
// reported on its own. A scenario id appearing at two versions inside one group is
// a real integrity problem (a scenario changed without a new comparison tuple), so
// it is surfaced as a warning rather than silently averaged across versions.

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { anyCaptureAttempt, anyMementoCall, type MementoCall } from './event-log.js';
import { type ResultRecord } from './record.js';
import { loadScenario, SCENARIO_CLASSES, type ScenarioClass } from './scenario.js';

export type { ScenarioClass };

// λ weights (§5.1) and guardrail thresholds (§5.3), plus the flake flag (§7.4).
export const DEFAULT_LAMBDA_READ = 0.33; // a spurious search is transient token flow
export const DEFAULT_LAMBDA_WRITE = 1.0; // a junk memory is persistent stock
export const TOKEN_OVERHEAD_LIMIT = 0.15; // §5.3: tokens ≤ +15% vs baseline
export const TASK_SUCCESS_ALLOWANCE = 0.05; // §5.3: ≥ baseline − 5pp
export const INVALID_CELL_THRESHOLD = 0.3; // §7.4: cell with >30% invalid is flagged
export const DEFAULT_BASELINE = 'baseline-0'; // the 0-line every knob is paired against (§10)

export interface ScoreOptions {
  lambdaRead: number;
  lambdaWrite: number;
  baseline: string;
}

export const DEFAULT_OPTIONS: ScoreOptions = {
  lambdaRead: DEFAULT_LAMBDA_READ,
  lambdaWrite: DEFAULT_LAMBDA_WRITE,
  baseline: DEFAULT_BASELINE,
};

// The two primary scores and the four rates they are built from (§5.1). A rate is
// null when the group has no reps of the class it needs, so "no data" never reads
// as a zero.
export interface Rates {
  utility_rate: number | null; // should-retrieve
  read_fp_rate: number | null; // should-not-retrieve
  good_capture_rate: number | null; // should-capture
  capture_fp_rate: number | null; // should-not-capture
  read_score: number | null;
  write_score: number | null;
}

// §5.4 diagnostics — logged, never used for decisions. empty_search_rate needs the
// per-search result_count the event-log parser now keeps; recall and read-through
// as §5.4 defines them need transcript ordering the stored calls don't carry, so
// they are deliberately absent here (see §5.4 note).
export interface Diagnostics {
  reps_ok: number; // scored reps (ok, not in a flagged cell)
  invalid_rate: number | null; // §7.4 invalid-rep rate, over ok+invalid attempts
  mem_calls_per_session: number | null;
  searches_per_session: number | null;
  empty_search_rate: number | null;
  capture_attempts_per_session: number | null;
  mean_duration_s: number | null;
  mean_turns: number | null;
  mean_cost_usd: number | null;
}

export type GuardrailState = 'ok' | 'fail' | 'baseline' | 'n/a';

export interface Guardrails {
  task_success_rate: number | null; // the config's rate over the shared scenario set
  baseline_task_rate: number | null;
  task: GuardrailState;
  token_ratio_max: number | null; // binding per-class token ratio vs baseline
  tokens: GuardrailState;
  violated: string[]; // e.g. ['task', 'tokens']
  disqualified: boolean;
}

export interface ConfigReport {
  config: string;
  is_baseline: boolean;
  rates: Rates;
  diagnostics: Diagnostics;
  guardrails: Guardrails;
  halted_cells: number; // reps the spend cap left unrun (§7.4) — matrix incompleteness
}

export interface FlaggedCell {
  config: string;
  scenario: string;
  invalid_rate: number;
  attempts: number; // ok + invalid attempts that fed the rate
}

export interface VersionConflict {
  scenario: string;
  versions: number[];
}

export interface GroupReport {
  harness: string; // 'claude-code' for pre-codex records (field absent)
  model: string;
  cc_version: string;
  env: string;
  configs: ConfigReport[];
  flagged_cells: FlaggedCell[];
  version_conflicts: VersionConflict[];
  baseline_present: boolean;
}

export interface ParsedLog {
  records: ResultRecord[];
  malformed: number;
}

const GROUP_SEP = '\u0000';
const CAPTURE_TOOLS = new Set(['create_memory', 'update_memory']);

// --- parsing -----------------------------------------------------------------

/** Parse a results.jsonl body, skipping blank and malformed lines (lenient, so a
 *  half-written final line never sinks a whole report). */
export function parseResults(text: string): ParsedLog {
  const records: ResultRecord[] = [];
  let malformed = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      malformed++;
      continue;
    }
    if (isResultRecord(parsed)) records.push(parsed);
    else malformed++;
  }
  return { records, malformed };
}

function isResultRecord(value: unknown): value is ResultRecord {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return (
    typeof r.config === 'string' &&
    typeof r.scenario === 'string' &&
    typeof r.scenario_version === 'number' &&
    typeof r.status === 'string' &&
    typeof r.model === 'string' &&
    typeof r.cc_version === 'string' &&
    typeof r.env === 'string' &&
    typeof r.raw === 'object' &&
    r.raw !== null
  );
}

// --- scenario class resolution -----------------------------------------------

/** Load the class for each scenario id still on disk (§5: metrics are per scenario
 *  class). This is only a fallback for records written before the class was
 *  persisted (§8.2): ids without a scenario.yaml — deleted, renamed, or moved into
 *  a holdout — are left out, and classOf then relies on the record's own field. */
export function buildClassMap(
  harnessRoot: string,
  ids: Iterable<string>,
): Map<string, ScenarioClass> {
  const map = new Map<string, ScenarioClass>();
  for (const id of new Set(ids)) {
    const path = join(harnessRoot, 'scenarios', id, 'scenario.yaml');
    if (!existsSync(path)) continue;
    try {
      map.set(id, loadScenario(path).class);
    } catch {
      // A malformed scenario on disk: leave unresolved, inference covers it.
    }
  }
  return map;
}

function isScenarioClass(value: unknown): value is ScenarioClass {
  return typeof value === 'string' && (SCENARIO_CLASSES as readonly string[]).includes(value);
}

// Class of a record. The record's own persisted class wins (§8.2): it survives a
// rename or retirement of the scenario dir, so history re-scores from the log
// alone. Only records predating that field fall back to the on-disk map, then to
// inference from the scored fields (utility → retrieve, capture → capture) and the
// id group prefix.
function classOf(rec: ResultRecord, classMap: Map<string, ScenarioClass>): ScenarioClass | null {
  if (isScenarioClass(rec.scenario_class)) return rec.scenario_class;
  const known = classMap.get(rec.scenario);
  if (known) return known;
  if (typeof rec.raw.utility_pass === 'boolean') return 'should-retrieve';
  if (rec.raw.capture !== null && typeof rec.raw.capture === 'object') return 'should-capture';
  const group = rec.scenario.split('/')[0] ?? '';
  if (group === 'read') return 'should-retrieve';
  if (group === 'no-read') return 'should-not-retrieve';
  if (group === 'write') return 'should-capture';
  if (group === 'no-write') return 'should-not-capture';
  return null;
}

// --- aggregation -------------------------------------------------------------

/** Group records into comparison groups and build a report per group. */
export function aggregate(
  records: ResultRecord[],
  classMap: Map<string, ScenarioClass>,
  options: ScoreOptions,
): GroupReport[] {
  const groups = new Map<string, ResultRecord[]>();
  for (const rec of records) {
    const key = [rec.harness ?? 'claude-code', rec.model, rec.cc_version, rec.env].join(GROUP_SEP);
    let bucket = groups.get(key);
    if (!bucket) groups.set(key, (bucket = []));
    bucket.push(rec);
  }

  const reports = [...groups.values()].map((group) => buildGroup(group, classMap, options));
  reports.sort(
    (a, b) =>
      a.harness.localeCompare(b.harness) ||
      a.model.localeCompare(b.model) ||
      a.cc_version.localeCompare(b.cc_version) ||
      a.env.localeCompare(b.env),
  );
  return reports;
}

function buildGroup(
  records: ResultRecord[],
  classMap: Map<string, ScenarioClass>,
  options: ScoreOptions,
): GroupReport {
  const first = records[0]!;
  const version_conflicts = findVersionConflicts(records);
  const { flaggedKeys, flagged_cells } = findFlaggedCells(records);

  // Scoring reps: ok, and not in a cell flagged for manual inspection (§7.4 "instead
  // of being scored").
  const scoring = records.filter(
    (r) => r.status === 'ok' && !flaggedKeys.has(cellKey(r.config, r.scenario)),
  );

  const configNames = [...new Set(records.map((r) => r.config))];
  const baselinePresent = configNames.includes(options.baseline);
  const baselineScoring = scoring.filter((r) => r.config === options.baseline);
  const classFor = (r: ResultRecord): ScenarioClass | null => classOf(r, classMap);

  const configs = configNames
    .map((name) =>
      buildConfigReport({
        name,
        all: records.filter((r) => r.config === name),
        scoring: scoring.filter((r) => r.config === name),
        baselineScoring,
        baselinePresent,
        isBaseline: name === options.baseline,
        classFor,
        options,
      }),
    )
    .sort(
      (a, b) => Number(b.is_baseline) - Number(a.is_baseline) || a.config.localeCompare(b.config),
    );

  return {
    harness: first.harness ?? 'claude-code',
    model: first.model,
    cc_version: first.cc_version,
    env: first.env,
    configs,
    flagged_cells,
    version_conflicts,
    baseline_present: baselinePresent,
  };
}

function findVersionConflicts(records: ResultRecord[]): VersionConflict[] {
  const byId = new Map<string, Set<number>>();
  for (const r of records) {
    let versions = byId.get(r.scenario);
    if (!versions) byId.set(r.scenario, (versions = new Set()));
    versions.add(r.scenario_version);
  }
  return [...byId.entries()]
    .filter(([, versions]) => versions.size > 1)
    .map(([scenario, versions]) => ({ scenario, versions: [...versions].sort((a, b) => a - b) }));
}

function findFlaggedCells(records: ResultRecord[]): {
  flaggedKeys: Set<string>;
  flagged_cells: FlaggedCell[];
} {
  const cells = new Map<
    string,
    { config: string; scenario: string; ok: number; invalid: number }
  >();
  for (const r of records) {
    if (r.status !== 'ok' && r.status !== 'invalid') continue; // halted: not a completed attempt
    const key = cellKey(r.config, r.scenario);
    let cell = cells.get(key);
    if (!cell)
      cells.set(key, (cell = { config: r.config, scenario: r.scenario, ok: 0, invalid: 0 }));
    if (r.status === 'ok') cell.ok++;
    else cell.invalid++;
  }

  const flaggedKeys = new Set<string>();
  const flagged_cells: FlaggedCell[] = [];
  for (const [key, cell] of cells) {
    const attempts = cell.ok + cell.invalid;
    const rate = attempts ? cell.invalid / attempts : 0;
    if (rate > INVALID_CELL_THRESHOLD) {
      flaggedKeys.add(key);
      flagged_cells.push({
        config: cell.config,
        scenario: cell.scenario,
        invalid_rate: rate,
        attempts,
      });
    }
  }
  flagged_cells.sort(
    (a, b) => a.config.localeCompare(b.config) || a.scenario.localeCompare(b.scenario),
  );
  return { flaggedKeys, flagged_cells };
}

interface ConfigInput {
  name: string;
  all: ResultRecord[]; // every record for the config (invalid-rate denominator)
  scoring: ResultRecord[]; // its scoring reps
  baselineScoring: ResultRecord[];
  baselinePresent: boolean;
  isBaseline: boolean;
  classFor: (r: ResultRecord) => ScenarioClass | null;
  options: ScoreOptions;
}

function buildConfigReport(input: ConfigInput): ConfigReport {
  const { scoring, classFor, options } = input;
  const inClass = (cls: ScenarioClass): ResultRecord[] =>
    scoring.filter((r) => classFor(r) === cls);

  const retrieve = inClass('should-retrieve').filter(
    (r) => typeof r.raw.utility_pass === 'boolean',
  );
  const utility_rate = fraction(
    retrieve.filter((r) => r.raw.utility_pass === true).length,
    retrieve.length,
  );

  const noRetrieve = withCalls(inClass('should-not-retrieve'));
  const read_fp_rate = fraction(
    noRetrieve.filter((x) => anyMementoCall(x.calls)).length,
    noRetrieve.length,
  );

  const capture = inClass('should-capture').filter((r) => capturePassed(r) !== null);
  const good_capture_rate = fraction(
    capture.filter((r) => capturePassed(r) === true).length,
    capture.length,
  );

  const noCapture = withCalls(inClass('should-not-capture'));
  const capture_fp_rate = fraction(
    noCapture.filter((x) => anyCaptureAttempt(x.calls)).length,
    noCapture.length,
  );

  const read_score =
    utility_rate === null ? null : utility_rate - options.lambdaRead * (read_fp_rate ?? 0);
  const write_score =
    good_capture_rate === null
      ? null
      : good_capture_rate - options.lambdaWrite * (capture_fp_rate ?? 0);

  const rates: Rates = {
    utility_rate,
    read_fp_rate,
    good_capture_rate,
    capture_fp_rate,
    read_score,
    write_score,
  };

  return {
    config: input.name,
    is_baseline: input.isBaseline,
    rates,
    diagnostics: computeDiagnostics(input.all, scoring),
    guardrails: computeGuardrails(input),
    halted_cells: input.all.filter((r) => r.status === 'halted').length,
  };
}

function computeDiagnostics(all: ResultRecord[], scoring: ResultRecord[]): Diagnostics {
  const scored = withCalls(scoring);

  let totalSearches = 0;
  let emptySearches = 0;
  for (const { calls } of scored) {
    for (const call of calls) {
      if (call.tool !== 'search_memory') continue;
      totalSearches++;
      if (call.result_count === 0) emptySearches++;
    }
  }

  let ok = 0;
  let invalid = 0;
  for (const r of all) {
    if (r.status === 'ok') ok++;
    else if (r.status === 'invalid') invalid++;
  }

  return {
    reps_ok: scoring.length,
    invalid_rate: fraction(invalid, ok + invalid),
    mem_calls_per_session: mean(scored.map((x) => x.calls.length)),
    searches_per_session: mean(scored.map((x) => countTool(x.calls, 'search_memory'))),
    empty_search_rate: totalSearches ? emptySearches / totalSearches : null,
    capture_attempts_per_session: mean(scored.map((x) => countCaptures(x.calls))),
    mean_duration_s: mean(numbers(scoring.map((r) => r.raw.duration_s))),
    mean_turns: mean(numbers(scoring.map((r) => r.raw.turns))),
    mean_cost_usd: mean(numbers(scoring.map((r) => r.raw.cost_usd))),
  };
}

// Guardrails (§5.3): compared against the baseline over the scenarios both configs
// actually ran (the honest paired basis, mirroring §6's "same scenarios"). Task
// success is a single rate; token overhead is checked per scenario class, since a
// read run and a write run have different token profiles — the binding (max) class
// ratio is reported.
function computeGuardrails(input: ConfigInput): Guardrails {
  const { scoring, baselineScoring, isBaseline, baselinePresent, classFor } = input;

  if (isBaseline) {
    const rate = taskRate(scoring);
    return {
      task_success_rate: rate,
      baseline_task_rate: rate,
      task: 'baseline',
      token_ratio_max: null,
      tokens: 'baseline',
      violated: [],
      disqualified: false,
    };
  }

  if (!baselinePresent) {
    return {
      task_success_rate: taskRate(scoring),
      baseline_task_rate: null,
      task: 'n/a',
      token_ratio_max: null,
      tokens: 'n/a',
      violated: [],
      disqualified: false,
    };
  }

  const shared = sharedScenarioIds(scoring, baselineScoring);
  const inShared = (r: ResultRecord): boolean => shared.has(r.scenario);
  const configTask = taskRate(scoring.filter(inShared));
  const baselineTask = taskRate(baselineScoring.filter(inShared));
  const taskFail =
    configTask !== null &&
    baselineTask !== null &&
    configTask < baselineTask - TASK_SUCCESS_ALLOWANCE;
  const task: GuardrailState =
    configTask === null || baselineTask === null ? 'n/a' : taskFail ? 'fail' : 'ok';

  const token = tokenGuardrail(
    scoring.filter(inShared),
    baselineScoring.filter(inShared),
    classFor,
  );
  const tokens: GuardrailState = !token.hasData ? 'n/a' : token.fail ? 'fail' : 'ok';

  const violated: string[] = [];
  if (taskFail) violated.push('task');
  if (token.fail) violated.push('tokens');

  return {
    task_success_rate: configTask,
    baseline_task_rate: baselineTask,
    task,
    token_ratio_max: token.maxRatio,
    tokens,
    violated,
    disqualified: violated.length > 0,
  };
}

function tokenGuardrail(
  config: ResultRecord[],
  baseline: ResultRecord[],
  classFor: (r: ResultRecord) => ScenarioClass | null,
): { maxRatio: number | null; fail: boolean; hasData: boolean } {
  let maxRatio: number | null = null;
  let fail = false;
  let hasData = false;
  for (const cls of SCENARIO_CLASSES) {
    const configMean = mean(numbers(config.filter((r) => classFor(r) === cls).map(tokensOf)));
    const baselineMean = mean(numbers(baseline.filter((r) => classFor(r) === cls).map(tokensOf)));
    if (configMean === null || baselineMean === null || baselineMean === 0) continue;
    hasData = true;
    const ratio = configMean / baselineMean;
    maxRatio = maxRatio === null ? ratio : Math.max(maxRatio, ratio);
    if (ratio > 1 + TOKEN_OVERHEAD_LIMIT) fail = true;
  }
  return { maxRatio, fail, hasData };
}

// --- rendering ---------------------------------------------------------------

export interface RenderOptions {
  color: boolean;
}

/** Render every group as terminal text, guardrail-violating rows dimmed (§8.2). */
export function renderReport(
  groups: GroupReport[],
  options: ScoreOptions,
  render: RenderOptions,
): string {
  if (groups.length === 0) return 'No records to report.';
  const blocks = groups.map((group) => renderGroup(group, options, render));
  blocks.push(legend(options));
  return blocks.join('\n\n');
}

function renderGroup(group: GroupReport, options: ScoreOptions, render: RenderOptions): string {
  const dim = group.configs.map((c) => c.guardrails.disqualified);
  const lines: string[] = [];
  lines.push(
    `═══ ${group.harness} · model ${group.model} · v${group.cc_version} · env ${group.env} ` +
      `(${group.configs.length} config${group.configs.length === 1 ? '' : 's'}) ═══`,
  );
  lines.push('');
  lines.push('Scores (§5.1)');
  lines.push(renderTable(SCORE_HEADERS, group.configs.map(scoreRow), SCORE_ALIGN, dim, render));
  lines.push('');
  lines.push('Diagnostics (§5.4)');
  lines.push(renderTable(DIAG_HEADERS, group.configs.map(diagRow), DIAG_ALIGN, dim, render));

  if (!group.baseline_present) {
    lines.push('');
    lines.push(
      `Note: no "${options.baseline}" config in this group — guardrails not evaluated (§5.3).`,
    );
  }
  for (const cell of group.flagged_cells) {
    lines.push(
      `Flagged (>30% invalid, excluded from scoring, §7.4): ${cell.config} × ${cell.scenario} ` +
        `— ${pct(cell.invalid_rate)} of ${cell.attempts} attempts.`,
    );
  }
  for (const config of group.configs) {
    if (config.halted_cells > 0) {
      lines.push(
        `Warning: ${config.config} has ${config.halted_cells} cell(s) halted at the spend cap ` +
          `(§7.4) — its matrix is incomplete, so deltas cover only the scenarios it ran.`,
      );
    }
  }
  for (const conflict of group.version_conflicts) {
    lines.push(
      `Warning: scenario ${conflict.scenario} spans versions [${conflict.versions.join(', ')}] ` +
        `in this group — scores may cross a scenario change (§9).`,
    );
  }
  return lines.join('\n');
}

const SCORE_HEADERS = [
  'config',
  'read',
  'write',
  'util',
  'r.fp',
  'gcap',
  'w.fp',
  'task%',
  'tok×',
  'status',
];
const SCORE_ALIGN: Align[] = ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'l'];

function scoreRow(c: ConfigReport): string[] {
  return [
    c.config,
    f2(c.rates.read_score),
    f2(c.rates.write_score),
    f2(c.rates.utility_rate),
    f2(c.rates.read_fp_rate),
    f2(c.rates.good_capture_rate),
    f2(c.rates.capture_fp_rate),
    pct(c.guardrails.task_success_rate),
    ratio(c.guardrails.token_ratio_max),
    statusLabel(c.guardrails),
  ];
}

const DIAG_HEADERS = [
  'config',
  'reps',
  'inv%',
  'mem/s',
  'srch/s',
  'empty%',
  'cap/s',
  'dur_s',
  'turns',
  'cost',
];
const DIAG_ALIGN: Align[] = ['l', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r', 'r'];

function diagRow(c: ConfigReport): string[] {
  const d = c.diagnostics;
  return [
    c.config,
    int(d.reps_ok),
    pct(d.invalid_rate),
    num1(d.mem_calls_per_session),
    num1(d.searches_per_session),
    pct(d.empty_search_rate),
    num1(d.capture_attempts_per_session),
    int(d.mean_duration_s),
    num1(d.mean_turns),
    money(d.mean_cost_usd),
  ];
}

function statusLabel(g: Guardrails): string {
  if (g.task === 'baseline') return 'base';
  if (g.disqualified) return `DQ:${g.violated.join(',')}`;
  if (g.task === 'n/a' && g.tokens === 'n/a') return 'n/a';
  return 'ok';
}

function legend(options: ScoreOptions): string {
  return [
    'Legend',
    `  read = utility_rate − ${options.lambdaRead}·read_fp_rate    write = good_capture_rate − ${options.lambdaWrite}·capture_fp_rate`,
    '  util/gcap: primary rates · r.fp/w.fp: false-positive rates · task%: oracle pass · tok×: tokens vs baseline',
    '  status: base = baseline · ok = within guardrails · DQ:x = disqualified (dimmed) · n/a = no baseline',
    '  Guardrails (§5.3): task ≥ baseline−5pp, tokens ≤ +15% vs baseline (per class, over shared scenarios).',
  ].join('\n');
}

// --- table + formatting helpers ----------------------------------------------

type Align = 'l' | 'r';

function renderTable(
  headers: string[],
  rows: string[][],
  align: Align[],
  dim: boolean[],
  render: RenderOptions,
): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((row) => (row[i] ?? '').length)),
  );
  const format = (cells: string[]): string =>
    cells
      .map((cell, i) =>
        align[i] === 'l' ? cell.padEnd(widths[i] ?? 0) : cell.padStart(widths[i] ?? 0),
      )
      .join('  ')
      .trimEnd();

  const lines = [
    format(headers),
    widths
      .map((w) => '─'.repeat(w))
      .join('  ')
      .trimEnd(),
  ];
  rows.forEach((row, i) => {
    const line = format(row);
    lines.push(render.color && dim[i] ? `${DIM}${line}${RESET}` : line);
  });
  return lines.join('\n');
}

const DIM = '\u001b[2m'; // ANSI dim — wraps guardrail-violating rows when color is on
const RESET = '\u001b[0m';
const DASH = '—'; // a null rate/score: "no data", never a zero

function f2(n: number | null): string {
  return n === null ? DASH : n.toFixed(2);
}

function pct(n: number | null): string {
  return n === null ? DASH : `${Math.round(n * 100)}%`;
}

function ratio(n: number | null): string {
  return n === null ? DASH : `${n.toFixed(2)}×`;
}

function num1(n: number | null): string {
  return n === null ? DASH : n.toFixed(1);
}

function int(n: number | null): string {
  return n === null ? DASH : Math.round(n).toString();
}

function money(n: number | null): string {
  return n === null ? DASH : `$${n.toFixed(2)}`;
}

// --- small record helpers ----------------------------------------------------

function cellKey(config: string, scenario: string): string {
  return `${config}${GROUP_SEP}${scenario}`;
}

function callsOf(rec: ResultRecord): MementoCall[] | null {
  const calls = rec.raw.memento_calls;
  return Array.isArray(calls) ? (calls as MementoCall[]) : null;
}

/** Reps paired with their Memento calls, dropping reps with no call data (an ok
 *  rep whose scoring degraded to UNSCORED) so it can't dilute an FP denominator. */
function withCalls(reps: ResultRecord[]): Array<{ rec: ResultRecord; calls: MementoCall[] }> {
  const out: Array<{ rec: ResultRecord; calls: MementoCall[] }> = [];
  for (const rec of reps) {
    const calls = callsOf(rec);
    if (calls !== null) out.push({ rec, calls });
  }
  return out;
}

function capturePassed(rec: ResultRecord): boolean | null {
  const capture = rec.raw.capture;
  if (capture === null || typeof capture !== 'object') return null;
  return (capture as { passed?: unknown }).passed === true;
}

function tokensOf(rec: ResultRecord): number | null {
  const { tokens_in, tokens_out } = rec.raw;
  if (tokens_in === null && tokens_out === null) return null;
  return (tokens_in ?? 0) + (tokens_out ?? 0);
}

function taskRate(reps: ResultRecord[]): number | null {
  const scored = reps.filter((r) => typeof r.raw.task_success === 'boolean');
  return fraction(scored.filter((r) => r.raw.task_success === true).length, scored.length);
}

function sharedScenarioIds(a: ResultRecord[], b: ResultRecord[]): Set<string> {
  const inB = new Set(b.map((r) => r.scenario));
  return new Set(a.map((r) => r.scenario).filter((id) => inB.has(id)));
}

function countTool(calls: MementoCall[], tool: string): number {
  return calls.filter((call) => call.tool === tool).length;
}

function countCaptures(calls: MementoCall[]): number {
  return calls.filter((call) => CAPTURE_TOOLS.has(call.tool)).length;
}

function fraction(count: number, total: number): number | null {
  return total ? count / total : null;
}

function mean(values: number[]): number | null {
  return values.length ? values.reduce((sum, v) => sum + v, 0) / values.length : null;
}

function numbers(values: Array<number | null>): number[] {
  return values.filter((v): v is number => typeof v === 'number' && !Number.isNaN(v));
}

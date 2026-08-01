// Run orchestration (harness-spec §7.2 steps 3–5, §7.4). executeCells is the
// scheduler: a fixed-size worker pool over the run's cells that enforces the
// flake policy (invalid reps retried once) and the spend cap (accumulate
// per-session cost, stop launching new reps once the cap is reached, finishing
// in-flight ones). It is decoupled from how a cell actually runs — a RunCell is
// injected — so the scheduling logic is testable without spawning Claude Code.
//
// makeRunCell is the real RunCell: it materializes the hermetic sandbox, runs one
// `claude -p` session, scores the rep against the sandbox's event log and fixture
// diff (§11.4), and appends a results record — all before cleanup, while the
// sandbox is still on disk. Invalid reps (timed out/crashed) are excluded from
// scoring (§7.4) and record UNSCORED placeholders.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { type Cell } from './plan.js';
import {
  buildRecord,
  UNSCORED,
  type RepStatus,
  type ResultRecord,
  type ScoredFacts,
} from './record.js';
import { loggedVariant, type MementoCall } from './event-log.js';
import { createSandbox } from './sandbox.js';
import { scoreRep } from './score.js';
import { type HarnessAdapter } from './harness.js';
import { runSession, type SessionResult } from './session.js';
import { sessionDiff } from './utility.js';

// Timeout for a scenario's task_success oracle (§5.3). Separate from the per-rep
// session timeout (§7.4): the oracle is a quick typecheck + test, not a model run.
export const ORACLE_TIMEOUT_S = 300;

// Cost charged to the spend cap for an attempt whose real cost can't be read from
// Claude Code's JSON — a timed-out/crashed session (SIGKILL leaves no parseable
// output) or one whose cost field went missing. Every attempt spawned a real
// `claude -p`, so it cost real money; charging $0 would let a systematically
// failing config run every cell while max_spend_usd never trips (§7.4). We can't
// recover the true figure, so charge a conservative estimate — deliberately above
// a normal short rep ($0.30–1.00, §9), since a timed-out rep ran the full per-rep
// budget — erring toward halting early, the safe direction for a cap. Accounting
// only; the record keeps the real (possibly null) cost so diagnostics stay honest.
export const DEFAULT_INVALID_REP_COST_USD = 2.0;

// The cost to charge one attempt against the spend cap: its measured cost, or the
// fallback estimate when Claude Code reported none (§7.4).
export function accountedCostUsd(session: SessionResult, fallbackUsd: number): number {
  return session.costUsd ?? fallbackUsd;
}

// A session that parsed as a completed (non-error) result yet carries no numeric
// cost is schema drift — e.g. a Claude Code update renamed `total_cost_usd`. The
// rep looks "ok" but its cost silently reads as null, so without surfacing it the
// spend cap would quietly stop advancing on every rep. Distinct from a timed-out
// or crashed session, where a null cost is expected and needs no warning.
export function costFieldMissing(session: SessionResult): boolean {
  return session.parsed && !session.isError && session.costUsd === null;
}

export interface RepOutcome {
  status: RepStatus;
  costUsd: number; // this attempt's session cost, for spend accounting
  record: ResultRecord;
}

// Runs one cell for one attempt (1-indexed). Injected so the scheduler is testable.
export type RunCell = (cell: Cell, attempt: number) => Promise<RepOutcome>;

export interface ExecuteOptions {
  concurrency: number;
  maxSpendUsd: number;
  retries: number;
}

export interface ExecuteSummary {
  launched: number;
  ok: number;
  invalid: number;
  halted: boolean; // hit the spend cap with cells still unlaunched
  skipped: number; // cells never launched because the cap tripped (recorded 'halted')
  spentUsd: number;
}

/**
 * Run the cells with bounded concurrency, retrying invalid reps and halting at
 * the spend cap. One record per rep is emitted via onRecord — the final attempt's
 * — while spend accounting sums every attempt (retries cost real money). Under
 * concurrency the cap is a soft ceiling: reps already in flight when it trips are
 * allowed to finish (§7.4).
 *
 * When the cap trips with cells still unlaunched, each remaining cell is emitted
 * as a 'halted' record via haltedRecord — so the log shows the matrix is short a
 * config rather than leaving those cells absent, which would let the report pair
 * deltas over non-matching scenario sets silently (§7.4, §8.2). `halted` is set
 * only in that case: a run that launches every cell — even one that lands spend
 * exactly on the cap with the last one — completed and is not halted.
 */
export async function executeCells(
  cells: Cell[],
  opts: ExecuteOptions,
  runCell: RunCell,
  onRecord: (record: ResultRecord) => void,
  haltedRecord: (cell: Cell) => ResultRecord,
): Promise<ExecuteSummary> {
  const summary: ExecuteSummary = {
    launched: 0,
    ok: 0,
    invalid: 0,
    halted: false,
    skipped: 0,
    spentUsd: 0,
  };
  let next = 0;

  const runWithRetry = async (cell: Cell): Promise<RepOutcome> => {
    let outcome = await runCell(cell, 1);
    let cost = outcome.costUsd;
    for (let attempt = 2; outcome.status === 'invalid' && attempt <= 1 + opts.retries; attempt++) {
      // A retry is another full session that costs real money; don't launch it if
      // the budget — everything spent so far plus this cell's attempts — is already
      // exhausted, or a config that fails every rep would retry past the cap (§7.4).
      if (summary.spentUsd + cost >= opts.maxSpendUsd) break;
      outcome = await runCell(cell, attempt);
      cost += outcome.costUsd;
    }
    return { ...outcome, costUsd: cost };
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= cells.length) return; // exhausted: the run completed, not halted
      if (summary.spentUsd >= opts.maxSpendUsd) {
        // Cap reached with this cell (and any after it) unlaunched: record it as
        // halted and keep draining so every skipped cell is accounted for.
        summary.halted = true;
        summary.skipped += 1;
        onRecord(haltedRecord(cells[index]!));
        continue;
      }
      const outcome = await runWithRetry(cells[index]!);
      summary.spentUsd += outcome.costUsd;
      summary.launched += 1;
      if (outcome.status === 'ok') summary.ok += 1;
      else summary.invalid += 1;
      onRecord(outcome.record);
    }
  };

  const workerCount = Math.min(opts.concurrency, cells.length);
  await Promise.all(Array.from({ length: workerCount }, worker));
  return summary;
}

export interface RunContext {
  run: string;
  harnessRoot: string;
  serverEntry: string; // bundled memento server (preflight.ts); '' if unused
  model: string;
  env: 'clean' | 'crowded';
  timeoutS: number;
  adapter: HarnessAdapter; // invocation/parse/config-home seam (harness.ts)
  ccVersion: string; // adapter's version (name kept from the pre-codex log)
  mementoVersion: string;
  policyVersion: string;
  configHashes: Map<string, string>; // config name → config_hash
  transcriptsDir: string; // absolute; per-run transcript directory
  oracleTimeoutS: number; // per-scenario task_success budget (§5.3)
  invalidRepCostUsd: number; // spend-cap estimate for a rep with no readable cost
}

/**
 * Build a 'halted' record for a cell the spend cap left unlaunched (§8.2). It
 * never ran, so it carries no session facts and UNSCORED placeholders — its role
 * is to mark the matrix cell as skipped, not to be scored.
 */
export function makeHaltedRecord(ctx: RunContext): (cell: Cell) => ResultRecord {
  return (cell) =>
    buildRecord({
      run: ctx.run,
      timestamp: new Date().toISOString(),
      model: ctx.model,
      ccVersion: ctx.ccVersion,
      mementoVersion: ctx.mementoVersion,
      policyVersion: ctx.policyVersion,
      env: ctx.env,
      cell,
      configHash: ctx.configHashes.get(cell.config.name) ?? '',
      status: 'halted',
      session: { cost_usd: null, duration_s: null, turns: null, tokens_in: null, tokens_out: null },
      scored: UNSCORED,
      transcriptPath: '',
      diffPath: null,
      harness: ctx.adapter.name,
    });
}

/** Build the real RunCell that spawns a session and records the rep. */
export function makeRunCell(ctx: RunContext): RunCell {
  return async (cell) => {
    const sandbox = createSandbox({
      harnessRoot: ctx.harnessRoot,
      serverEntry: ctx.serverEntry,
      config: cell.config,
      scenario: cell.scenario,
      env: ctx.env,
      adapter: ctx.adapter,
    });
    try {
      const invocation = ctx.adapter.buildInvocation({
        repoDir: sandbox.repoDir,
        configHome: sandbox.ccConfigDir,
        mcpConfigPath: sandbox.mcpConfigPath,
        task: cell.scenario.task,
        model: ctx.model,
      });
      const run = await runSession(invocation, ctx.timeoutS, Date.now, (msg) =>
        console.error(`[${cell.config.name} × ${cell.scenario.id} rep ${cell.rep}] ${msg}`),
      );
      const session = ctx.adapter.parseResult(run.stdout);
      // Invalid = timed out or crashed (§7.4), not a task the agent merely failed.
      const invalid = run.timedOut || run.exitCode !== 0 || !session.parsed || session.isError;
      const status: RepStatus = invalid ? 'invalid' : 'ok';
      // Cost-drift warning only where cost is expected at all: codex never
      // reports one, so its reps charge the fallback silently by design (§7.4).
      if (ctx.adapter.costReported && costFieldMissing(session)) {
        console.error(
          `Cost missing for ${cell.config.name} × ${cell.scenario.id} rep ${cell.rep}: ` +
            'Claude Code reported a completed session with no total_cost_usd — the output shape ' +
            'may have changed. Charging the fallback estimate to the spend cap (§7.4).',
        );
      }
      const transcriptPath = saveTranscript(ctx, cell, run.stdout);
      const diffPath =
        status === 'ok' ? saveDiff(ctx, cell, sandbox.repoDir, sandbox.baselineRef) : null;

      // Score before cleanup, while the sandbox's event log, captured memories,
      // and fixture diff are still on disk. Invalid reps are excluded from
      // scoring (§7.4); a scoring failure degrades to UNSCORED rather than losing
      // the whole rep — the session's own diagnostics are still recorded.
      const scored =
        status === 'ok'
          ? scoreOrWarn(ctx, cell, sandbox.mementoHome, sandbox.repoDir, sandbox.baselineRef)
          : UNSCORED;
      warnOnVariantDrift(cell, scored.memento_calls);

      const record = buildRecord({
        run: ctx.run,
        timestamp: new Date().toISOString(),
        model: ctx.model,
        ccVersion: ctx.ccVersion,
        mementoVersion: ctx.mementoVersion,
        policyVersion: ctx.policyVersion,
        env: ctx.env,
        cell,
        configHash: ctx.configHashes.get(cell.config.name) ?? '',
        status,
        session: {
          cost_usd: session.costUsd,
          // Lower-bound signal for the file-access channel: codex transcripts
          // carry command output; claude-code result-only transcripts mostly don't.
          corpus_file_access:
            run.stdout.includes(sandbox.mementoHome) || run.stdout.includes('memento-home'),
          duration_s: session.durationS ?? run.durationS,
          turns: session.turns,
          tokens_in: session.tokensIn,
          tokens_out: session.tokensOut,
        },
        scored,
        transcriptPath,
        diffPath,
        harness: ctx.adapter.name,
      });
      return { status, costUsd: accountedCostUsd(session, ctx.invalidRepCostUsd), record };
    } finally {
      sandbox.cleanup();
    }
  };
}

// Warn if the server logged a different MEMENTO_VARIANT than the config declared.
// A blanked/corrupted env would run the wrong knob arm and poison a baseline every
// delta is paired against, undetectably (§10). Fires only when both are known and
// differ — baseline-no-memento (null) and reps with no memento calls are skipped.
function warnOnVariantDrift(cell: Cell, calls: unknown[] | null): void {
  if (!Array.isArray(calls)) return;
  const logged = loggedVariant(calls as MementoCall[]);
  const expected = cell.config.memento_variant;
  if (logged !== null && expected !== null && logged !== expected) {
    console.error(
      `Variant drift for ${cell.config.name} × ${cell.scenario.id} rep ${cell.rep}: config ` +
        `declares MEMENTO_VARIANT=${expected} but the server logged "${logged}". The env may ` +
        'have been corrupted — treat this rep as contaminated (§10).',
    );
  }
}

// Score a rep, or warn and fall back to UNSCORED. A scorer failure (a bad
// scenario regex, a git/oracle hiccup) must not abort the run and lose the other
// cells; it is logged so it does not pass silently.
function scoreOrWarn(
  ctx: RunContext,
  cell: Cell,
  mementoHome: string,
  repoDir: string,
  baselineRef: string,
): ScoredFacts {
  try {
    return scoreRep({
      scenario: cell.scenario,
      harnessRoot: ctx.harnessRoot,
      mementoHome,
      repoDir,
      baselineRef,
      oracleTimeoutS: ctx.oracleTimeoutS,
    });
  } catch (error) {
    console.error(
      `Scoring failed for ${cell.config.name} × ${cell.scenario.id} rep ${cell.rep}:`,
      error,
    );
    return UNSCORED;
  }
}

// Persist a rep's raw transcript under the run's transcript dir, returning a
// harness-root-relative path for the record (§8.2 transcript_path). A retried rep
// reuses the name so the file reflects the final attempt.
function saveTranscript(ctx: RunContext, cell: Cell, stdout: string): string {
  mkdirSync(ctx.transcriptsDir, { recursive: true });
  const scenario = cell.scenario.id.replace(/\//g, '-');
  const file = `${cell.config.name}__${scenario}__rep${cell.rep}.json`;
  const abs = join(ctx.transcriptsDir, file);
  writeFileSync(abs, stdout);
  return relative(ctx.harnessRoot, abs);
}

// Persist the session diff beside the transcript so a utility verdict can be
// audited after the sandbox is deleted. Never fatal: a git hiccup here loses one
// diagnostic artifact, not the rep.
function saveDiff(
  ctx: RunContext,
  cell: Cell,
  repoDir: string,
  baselineRef: string,
): string | null {
  try {
    const scenario = cell.scenario.id.replace(/\//g, '-');
    const abs = join(ctx.transcriptsDir, `${cell.config.name}__${scenario}__rep${cell.rep}.diff`);
    writeFileSync(abs, sessionDiff(repoDir, baselineRef));
    return relative(ctx.harnessRoot, abs);
  } catch (error) {
    console.error(`Diff save failed for ${cell.config.name} × ${cell.scenario.id}:`, error);
    return null;
  }
}

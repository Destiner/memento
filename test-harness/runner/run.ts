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
import { createSandbox } from './sandbox.js';
import { scoreRep } from './score.js';
import { buildClaudeInvocation, parseSessionResult, runSession } from './session.js';

// Timeout for a scenario's task_success oracle (§5.3). Separate from the per-rep
// session timeout (§7.4): the oracle is a quick typecheck + test, not a model run.
export const ORACLE_TIMEOUT_S = 300;

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
  halted: boolean; // stopped early at the spend cap
  spentUsd: number;
}

/**
 * Run the cells with bounded concurrency, retrying invalid reps and halting at
 * the spend cap. One record per rep is emitted via onRecord — the final attempt's
 * — while spend accounting sums every attempt (retries cost real money). Under
 * concurrency the cap is a soft ceiling: reps already in flight when it trips are
 * allowed to finish (§7.4).
 */
export async function executeCells(
  cells: Cell[],
  opts: ExecuteOptions,
  runCell: RunCell,
  onRecord: (record: ResultRecord) => void,
): Promise<ExecuteSummary> {
  const summary: ExecuteSummary = { launched: 0, ok: 0, invalid: 0, halted: false, spentUsd: 0 };
  let next = 0;

  const runWithRetry = async (cell: Cell): Promise<RepOutcome> => {
    let outcome = await runCell(cell, 1);
    let cost = outcome.costUsd;
    for (let attempt = 2; outcome.status === 'invalid' && attempt <= 1 + opts.retries; attempt++) {
      outcome = await runCell(cell, attempt);
      cost += outcome.costUsd;
    }
    return { ...outcome, costUsd: cost };
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (summary.spentUsd >= opts.maxSpendUsd) {
        summary.halted = true;
        return;
      }
      const index = next++;
      if (index >= cells.length) return;
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
  repoRoot: string;
  model: string;
  env: 'clean' | 'crowded';
  timeoutS: number;
  ccVersion: string;
  mementoVersion: string;
  configHashes: Map<string, string>; // config name → config_hash
  transcriptsDir: string; // absolute; per-run transcript directory
  oracleTimeoutS: number; // per-scenario task_success budget (§5.3)
}

/** Build the real RunCell that spawns a session and records the rep. */
export function makeRunCell(ctx: RunContext): RunCell {
  return async (cell) => {
    const sandbox = createSandbox({
      harnessRoot: ctx.harnessRoot,
      repoRoot: ctx.repoRoot,
      config: cell.config,
      scenario: cell.scenario,
      env: ctx.env,
    });
    try {
      const invocation = buildClaudeInvocation({
        repoDir: sandbox.repoDir,
        ccConfigDir: sandbox.ccConfigDir,
        mcpConfigPath: sandbox.mcpConfigPath,
        task: cell.scenario.task,
        model: ctx.model,
      });
      const run = await runSession(invocation, ctx.timeoutS, Date.now);
      const session = parseSessionResult(run.stdout);
      // Invalid = timed out or crashed (§7.4), not a task the agent merely failed.
      const invalid = run.timedOut || run.exitCode !== 0 || !session.parsed || session.isError;
      const status: RepStatus = invalid ? 'invalid' : 'ok';
      const transcriptPath = saveTranscript(ctx, cell, run.stdout);

      // Score before cleanup, while the sandbox's event log, captured memories,
      // and fixture diff are still on disk. Invalid reps are excluded from
      // scoring (§7.4); a scoring failure degrades to UNSCORED rather than losing
      // the whole rep — the session's own diagnostics are still recorded.
      const scored =
        status === 'ok' ? scoreOrWarn(ctx, cell, sandbox.mementoHome, sandbox.repoDir) : UNSCORED;

      const record = buildRecord({
        run: ctx.run,
        timestamp: new Date().toISOString(),
        model: ctx.model,
        ccVersion: ctx.ccVersion,
        mementoVersion: ctx.mementoVersion,
        env: ctx.env,
        cell,
        configHash: ctx.configHashes.get(cell.config.name) ?? '',
        status,
        session: {
          cost_usd: session.costUsd,
          duration_s: session.durationS ?? run.durationS,
          turns: session.turns,
          tokens_in: session.tokensIn,
          tokens_out: session.tokensOut,
        },
        scored,
        transcriptPath,
      });
      return { status, costUsd: session.costUsd ?? 0, record };
    } finally {
      sandbox.cleanup();
    }
  };
}

// Score a rep, or warn and fall back to UNSCORED. A scorer failure (a bad
// scenario regex, a git/oracle hiccup) must not abort the run and lose the other
// cells; it is logged so it does not pass silently.
function scoreOrWarn(
  ctx: RunContext,
  cell: Cell,
  mementoHome: string,
  repoDir: string,
): ScoredFacts {
  try {
    return scoreRep({
      scenario: cell.scenario,
      harnessRoot: ctx.harnessRoot,
      mementoHome,
      repoDir,
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

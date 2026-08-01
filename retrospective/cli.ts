import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadConfig, resolveHome } from '../src/config.js';
import { loadEvents } from '../src/report/load.js';
import { stableId as historyStableId } from './adapters/common.js';
import { openRetrospectiveStore, type RetrospectiveStore } from './db/store.js';
import { COMPARISON_LABELS, type ComparisonLabel, type ReviewCommand } from './db/types.js';
import { discoverHistorySources, type HistorySource } from './discover.js';
import { ClaudeCodeEvaluator, CodexEvaluator } from './evaluator/index.js';
import { exportRegressionJsonl } from './export.js';
import type { JsonValue } from './model.js';
import { runRetrospective } from './pipeline.js';
import {
  isPromotionEligible,
  promoteApprovedWriteFromHome,
  reconcileStartedPromotionFromHome,
} from './promote.js';
import { buildReviewedReport, renderReviewedReport } from './report.js';
import { applyReviewFromHome, renderReviewItem } from './review.js';

const FLAG_OPTIONS = new Set(['allow-remote', 'all', 'json', 'help']);

export interface CliIo {
  stdout(value: string): void;
}

const DEFAULT_IO: CliIo = {
  stdout(value) {
    process.stdout.write(`${value}\n`);
  },
};

export async function runCli(argv: string[], io: CliIo = DEFAULT_IO): Promise<void> {
  const parsed = parseArguments(argv);
  const command = parsed.positionals.shift() ?? 'help';
  if (parsed.flags.has('help') || command === 'help') {
    io.stdout(HELP);
    return;
  }

  if (command === 'discover') {
    assertOptions(parsed, ['client']);
    const client = singleOption(parsed, 'client') ?? 'both';
    if (!['both', 'claude-code', 'codex'].includes(client)) {
      throw new Error('--client must be one of: both, claude-code, codex.');
    }
    assertNoPositionals(parsed);
    const discovery = await discoverHistorySources();
    const sources = discovery.sources.filter(
      (source) => client === 'both' || source.client === client,
    );
    io.stdout(JSON.stringify({ sources, warnings: discovery.warnings }, null, 2));
    return;
  }

  const home = resolve(singleOption(parsed, 'home') ?? resolveHome());
  const store = await openRetrospectiveStore({ home });
  try {
    await dispatchStoreCommand(command, parsed, store, home, io);
  } finally {
    store.close();
  }
}

async function dispatchStoreCommand(
  command: string,
  parsed: ParsedArguments,
  store: RetrospectiveStore,
  home: string,
  io: CliIo,
): Promise<void> {
  if (command === 'run') {
    assertOptions(parsed, [
      'source',
      'evaluator',
      'model',
      'max-tasks',
      'source-policy-version',
      'run-salt',
      'home',
      'allow-remote',
    ]);
    assertNoPositionals(parsed);
    if (!parsed.flags.has('allow-remote')) {
      throw new Error(
        'Remote evaluation is disabled by default. Re-run with --allow-remote after reviewing the selected histories.',
      );
    }
    const evaluatorName = requiredOption(parsed, 'evaluator');
    const model = requiredOption(parsed, 'model');
    const sources = optionValues(parsed, 'source').map(parseHistorySource);
    if (sources.length === 0) {
      throw new Error('Provide at least one explicit --source <claude-code|codex>:<path>.');
    }
    const maxTasks = positiveInteger(singleOption(parsed, 'max-tasks') ?? '1', '--max-tasks');
    const evaluator =
      evaluatorName === 'claude-code'
        ? new ClaudeCodeEvaluator({ model })
        : evaluatorName === 'codex'
          ? new CodexEvaluator({ model })
          : undefined;
    if (evaluator === undefined) {
      throw new Error('--evaluator must be either claude-code or codex.');
    }
    const config = loadConfig(home);
    const telemetryEvents = await loadEvents(config.paths.logs);
    const result = await runRetrospective({
      store,
      paths: config.paths,
      sources,
      telemetryEvents,
      evaluator,
      maxTasks,
      ...(singleOption(parsed, 'source-policy-version')
        ? { sourcePolicyVersion: singleOption(parsed, 'source-policy-version') }
        : {}),
      ...(singleOption(parsed, 'run-salt') ? { runSalt: singleOption(parsed, 'run-salt') } : {}),
    });
    io.stdout(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'runs') {
    assertOptions(parsed, ['home', 'json']);
    assertNoPositionals(parsed);
    const runs = store.listRuns();
    io.stdout(
      parsed.flags.has('json')
        ? JSON.stringify(runs, null, 2)
        : runs
            .map(
              (run) =>
                `${run.id} ${run.status} policy=${run.sourcePolicyVersion} pipeline=${run.pipelineVersion}`,
            )
            .join('\n') || 'No retrospective runs.',
    );
    return;
  }

  if (command === 'queue') {
    assertOptions(parsed, ['home', 'all', 'json']);
    const runId = optionalPositional(parsed);
    const items = store.listReviewQueue(runId, parsed.flags.has('all'));
    io.stdout(
      parsed.flags.has('json')
        ? JSON.stringify(items, null, 2)
        : items.map(renderReviewItem).join('\n\n') || 'Review queue is empty.',
    );
    return;
  }

  if (command === 'review') {
    assertOptions(parsed, [
      'home',
      'actor',
      'reason',
      'revision',
      'label',
      'actual-operation',
      'target-memory',
    ]);
    const comparisonId = requiredPositional(parsed, 'comparison id');
    const action = requiredPositional(parsed, 'review action');
    assertNoPositionals(parsed);
    const review = await reviewCommand(action, parsed);
    const event = await applyReviewFromHome(store, comparisonId, review, home);
    const item = store.reviewItem(comparisonId);
    const runStatus = refreshRunStatus(store, item.runId);
    const pending = store.listReviewQueue(item.runId).length;
    io.stdout(JSON.stringify({ event, pending, runStatus }, null, 2));
    return;
  }

  if (command === 'promote') {
    assertOptions(parsed, ['home']);
    const comparisonId = requiredPositional(parsed, 'comparison id');
    assertNoPositionals(parsed);
    const item = store.reviewItem(comparisonId);
    const result = await promoteApprovedWriteFromHome(store, comparisonId, home);
    const runStatus = refreshRunStatus(store, item.runId);
    io.stdout(JSON.stringify({ ...result, runStatus }, null, 2));
    return;
  }

  if (command === 'reconcile-promotion') {
    assertOptions(parsed, ['home', 'actor', 'reason', 'memory']);
    const comparisonId = requiredPositional(parsed, 'comparison id');
    const status = requiredPositional(parsed, 'reconciliation status');
    assertNoPositionals(parsed);
    const actor = requiredOption(parsed, 'actor');
    const reason = requiredOption(parsed, 'reason');
    const outcome =
      status === 'succeeded'
        ? {
            status: 'succeeded' as const,
            actor,
            reason,
            memoryId: requiredOption(parsed, 'memory'),
            home,
          }
        : status === 'failed'
          ? { status: 'failed' as const, actor, reason, home }
          : undefined;
    if (outcome === undefined) {
      throw new Error('Reconciliation status must be either succeeded or failed.');
    }
    if (status === 'failed' && singleOption(parsed, 'memory') !== undefined) {
      throw new Error('--memory is only valid for a succeeded reconciliation.');
    }
    const result = await reconcileStartedPromotionFromHome(store, comparisonId, outcome);
    const item = store.reviewItem(comparisonId);
    const runStatus = refreshRunStatus(store, item.runId);
    io.stdout(JSON.stringify({ ...result, runStatus }, null, 2));
    return;
  }

  if (command === 'report') {
    assertOptions(parsed, ['home', 'json']);
    const runId = requiredPositional(parsed, 'run id');
    assertNoPositionals(parsed);
    const report = buildReviewedReport(store, runId);
    io.stdout(
      parsed.flags.has('json') ? JSON.stringify(report, null, 2) : renderReviewedReport(report),
    );
    return;
  }

  if (command === 'export') {
    assertOptions(parsed, ['home', 'output']);
    const runId = requiredPositional(parsed, 'run id');
    assertNoPositionals(parsed);
    const output = resolve(requiredOption(parsed, 'output'));
    const result = await exportRegressionJsonl(store, runId, output);
    io.stdout(JSON.stringify(result, null, 2));
    return;
  }

  throw new Error(
    `Unknown retrospective command: ${command}. Run "bun run retrospective -- help".`,
  );
}

export function parseHistorySource(value: string): HistorySource {
  const match = /^(claude-code|codex):(.*)$/.exec(value);
  if (!match?.[1] || !match[2]?.trim()) {
    throw new Error(
      `Invalid history source ${JSON.stringify(value)}; expected <claude-code|codex>:<path>.`,
    );
  }
  const client = match[1] as HistorySource['client'];
  const path = resolve(match[2]);
  return { id: historyStableId('src', client, path), client, path };
}

async function reviewCommand(action: string, parsed: ParsedArguments): Promise<ReviewCommand> {
  const actor = requiredOption(parsed, 'actor');
  if (action === 'approve') {
    assertOptions(parsed, ['home', 'actor']);
    return { action, actor };
  }
  const reason = requiredOption(parsed, 'reason');
  if (action === 'reject') {
    assertOptions(parsed, ['home', 'actor', 'reason']);
    return { action, actor, reason };
  }
  if (action === 'duplicate') {
    assertOptions(parsed, ['home', 'actor', 'reason', 'target-memory']);
    return {
      action,
      actor,
      reason,
      targetMemoryId: requiredOption(parsed, 'target-memory'),
    };
  }
  if (action === 'edit') {
    assertOptions(parsed, ['home', 'actor', 'reason', 'revision', 'label', 'actual-operation']);
    const path = resolve(requiredOption(parsed, 'revision'));
    const revision = JSON.parse(await readFile(path, 'utf8')) as JsonValue;
    const label = requiredOption(parsed, 'label');
    if (!COMPARISON_LABELS.includes(label as ComparisonLabel)) {
      throw new Error(`--label must be one of: ${COMPARISON_LABELS.join(', ')}.`);
    }
    const reviewedActual = requiredOption(parsed, 'actual-operation');
    return {
      action,
      actor,
      reason,
      revision,
      label: label as ComparisonLabel,
      actualOperationId: reviewedActual === 'none' ? null : reviewedActual,
    };
  }
  throw new Error('Review action must be one of: approve, edit, reject, duplicate.');
}

interface ParsedArguments {
  positionals: string[];
  options: Map<string, string[]>;
  flags: Set<string>;
}

function parseArguments(argv: string[]): ParsedArguments {
  const parsed: ParsedArguments = { positionals: [], options: new Map(), flags: new Set() };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (!argument.startsWith('--')) {
      parsed.positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    const name = argument.slice(2, equals < 0 ? undefined : equals);
    if (name === '') throw new Error('Invalid empty option name.');
    if (equals >= 0) {
      addOption(parsed, name, argument.slice(equals + 1));
      continue;
    }
    if (FLAG_OPTIONS.has(name)) {
      parsed.flags.add(name);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`--${name} requires a value.`);
    }
    addOption(parsed, name, value);
    index += 1;
  }
  return parsed;
}

function addOption(parsed: ParsedArguments, name: string, value: string): void {
  const values = parsed.options.get(name) ?? [];
  values.push(value);
  parsed.options.set(name, values);
}

function optionValues(parsed: ParsedArguments, name: string): string[] {
  return parsed.options.get(name) ?? [];
}

function singleOption(parsed: ParsedArguments, name: string): string | undefined {
  const values = optionValues(parsed, name);
  if (values.length > 1) throw new Error(`--${name} may only be provided once.`);
  return values[0];
}

function requiredOption(parsed: ParsedArguments, name: string): string {
  const value = singleOption(parsed, name);
  if (value === undefined || value.trim() === '') throw new Error(`--${name} is required.`);
  return value;
}

function requiredPositional(parsed: ParsedArguments, label: string): string {
  const value = parsed.positionals.shift();
  if (value === undefined) throw new Error(`Missing ${label}.`);
  return value;
}

function optionalPositional(parsed: ParsedArguments): string | undefined {
  const value = parsed.positionals.shift();
  assertNoPositionals(parsed);
  return value;
}

function assertNoPositionals(parsed: ParsedArguments): void {
  if (parsed.positionals.length > 0) {
    throw new Error(`Unexpected argument: ${parsed.positionals[0]}.`);
  }
}

function assertOptions(parsed: ParsedArguments, allowed: string[]): void {
  const allowedSet = new Set(allowed);
  for (const option of [...parsed.options.keys(), ...parsed.flags]) {
    if (!allowedSet.has(option)) throw new Error(`Unknown option for this command: --${option}.`);
  }
}

function positiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${option} must be a positive integer.`);
  }
  return parsed;
}

function refreshRunStatus(store: RetrospectiveStore, runId: string): 'reviewing' | 'complete' {
  const all = store.listReviewQueue(runId, true);
  const pending = store.listReviewQueue(runId);
  const promotionComplete = all
    .filter(isPromotionEligible)
    .every((item) => store.latestPromotion(item.id)?.status === 'succeeded');
  const status = pending.length === 0 && promotionComplete ? 'complete' : 'reviewing';
  store.setRunStatus(runId, status);
  return status;
}

const HELP = `Memento retrospective evaluation

Usage:
  bun run retrospective -- discover [--client both|claude-code|codex]
  bun run retrospective -- run --source <client:path>... --evaluator <claude-code|codex> \\
    --model <model> --allow-remote [--max-tasks 1] [--source-policy-version unknown] \\
    [--run-salt <label>]
  bun run retrospective -- runs [--json]
  bun run retrospective -- queue [run-id] [--all] [--json]
  bun run retrospective -- review <comparison-id> <approve|edit|reject|duplicate> --actor <name> \\
    [--reason <text>] [--revision <proposal.json>] [--label <classification>] \\
    [--actual-operation <operation-id|none>] [--target-memory <mem_id>]
  bun run retrospective -- promote <comparison-id>
  bun run retrospective -- reconcile-promotion <comparison-id> <succeeded|failed> \\
    --actor <name> --reason <text> [--memory <mem_id>]
  bun run retrospective -- report <run-id> [--json]
  bun run retrospective -- export <run-id> --output <path>

Every store command accepts --home <MEMENTO_HOME>. Run analyzes only explicit source paths,
defaults to one task, and cannot contact a remote evaluator without --allow-remote.`;

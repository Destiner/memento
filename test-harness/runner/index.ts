#!/usr/bin/env bun
// Harness runner entrypoint (harness-spec §8.1).
//
//   bun run harness -- manifests/<name>.yaml
//
// Loads a run manifest, plans its cells, and executes the hermetic per-rep
// lifecycle (§7.2) under the spend cap and flake policy (§7.4), appending one
// scored results record per rep to results/results.jsonl (§8.2, §11.4).

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadManifest } from './manifest.js';
import { planRun } from './plan.js';
import { configHash } from './record.js';
import {
  DEFAULT_INVALID_REP_COST_USD,
  executeCells,
  makeHaltedRecord,
  makeRunCell,
  ORACLE_TIMEOUT_S,
  type RunContext,
} from './run.js';

const HARNESS_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const REPO_ROOT = resolve(HARNESS_ROOT, '..');

async function main(argv: string[]): Promise<void> {
  const manifestPath = argv[0];
  if (!manifestPath) {
    console.error('Usage: bun run harness -- <manifest.yaml>');
    process.exit(1);
  }

  const resolved = resolve(manifestPath);
  if (!existsSync(resolved)) {
    console.error(`Manifest not found: ${resolved}`);
    process.exit(1);
  }

  const manifest = loadManifest(resolved);
  const plan = planRun(HARNESS_ROOT, manifest);

  const resultsDir = join(HARNESS_ROOT, 'results');
  const resultsLog = join(resultsDir, 'results.jsonl');
  const transcriptsDir = join(resultsDir, 'transcripts', manifest.name);
  mkdirSync(transcriptsDir, { recursive: true });

  const configHashes = new Map(
    plan.configs.map((config) => [
      config.name,
      configHash(join(HARNESS_ROOT, 'configs', config.name)),
    ]),
  );

  const ctx: RunContext = {
    run: manifest.name,
    harnessRoot: HARNESS_ROOT,
    repoRoot: REPO_ROOT,
    model: manifest.model,
    env: manifest.env,
    timeoutS: manifest.timeout_s,
    ccVersion: detectClaudeVersion(),
    mementoVersion: readMementoVersion(),
    configHashes,
    transcriptsDir,
    oracleTimeoutS: ORACLE_TIMEOUT_S,
    invalidRepCostUsd: DEFAULT_INVALID_REP_COST_USD,
  };

  console.error(
    `Running ${manifest.name}: ${plan.cells.length} cells ` +
      `(${plan.configs.length} configs × ${plan.scenarios.length} scenarios × ${manifest.reps} reps), ` +
      `${manifest.env} env, cap $${manifest.max_spend_usd}.`,
  );

  const summary = await executeCells(
    plan.cells,
    {
      concurrency: manifest.concurrency,
      maxSpendUsd: manifest.max_spend_usd,
      retries: manifest.retries,
    },
    makeRunCell(ctx),
    (record) => appendFileSync(resultsLog, JSON.stringify(record) + '\n'),
    makeHaltedRecord(ctx),
  );

  console.error(
    `Done: ${summary.ok} ok, ${summary.invalid} invalid, $${summary.spentUsd.toFixed(2)} spent` +
      `${summary.halted ? ` (halted at spend cap; ${summary.skipped} cells skipped)` : ''}. ` +
      `Records → ${resultsLog}`,
  );
}

// Claude Code version recorded in every rep (§8.2); baselines rerun on change (§10).
function detectClaudeVersion(): string {
  const raw = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  return /\d+\.\d+\.\d+/.exec(raw)?.[0] ?? raw;
}

function readMementoVersion(): string {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
    version?: string;
  };
  return pkg.version ?? 'unknown';
}

main(process.argv.slice(2)).catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});

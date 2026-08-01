#!/usr/bin/env bun
// Harness runner entrypoint (harness-spec §8.1).
//
//   bun run harness -- manifests/<name>.yaml
//
// Loads a run manifest, plans its cells, and executes the hermetic per-rep
// lifecycle (§7.2) under the spend cap and flake policy (§7.4), appending one
// scored results record per rep to results/results.jsonl (§8.2, §11.4).

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AGENT_FRAGMENT, POLICY_VERSION } from '../../src/policy/index.js';

import { makeAdapter } from './harness.js';
import { loadManifest } from './manifest.js';
import { planRun } from './plan.js';
import { preflightMemento } from './preflight.js';
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

  // Abort before spending: a memento server that can't handshake would record
  // zero tool calls on every rep, indistinguishable from real behavior (§7.2).
  const variants = plan.configs
    .map((config) => config.memento_variant)
    .filter((variant): variant is string => variant !== null);
  const serverEntry = await preflightMemento(REPO_ROOT, variants);
  if (variants.length > 0)
    console.error(`Preflight ok: memento handshake for [${[...new Set(variants)].join(', ')}].`);

  const resultsDir = join(HARNESS_ROOT, 'results');
  const resultsLog = join(resultsDir, 'results.jsonl');
  const transcriptsDir = join(resultsDir, 'transcripts', manifest.name);
  mkdirSync(transcriptsDir, { recursive: true });

  const configHashes = new Map(
    plan.configs.map((config) => [
      config.name,
      configHash(
        join(HARNESS_ROOT, 'configs', config.name),
        config.install?.agent_instructions === 'memento'
          ? { [adapterInstructionsFilename(manifest.harness)]: AGENT_FRAGMENT }
          : undefined,
      ),
    ]),
  );

  const adapter = makeAdapter(manifest.harness);
  const ctx: RunContext = {
    run: manifest.name,
    harnessRoot: HARNESS_ROOT,
    serverEntry,
    model: manifest.model,
    env: manifest.env,
    timeoutS: manifest.timeout_s,
    adapter,
    ccVersion: adapter.detectVersion(),
    mementoVersion: readMementoVersion(),
    policyVersion: POLICY_VERSION,
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

function adapterInstructionsFilename(harness: string): string {
  return harness === 'codex' ? 'AGENTS.md' : 'CLAUDE.md';
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

// Run-manifest schema + loader (harness-spec §8.1). One manifest.yaml per run
// names a batch of (config × scenario × rep) cells, the model and environment
// they run under, the concurrency, and — load-bearing for cost safety — the
// spend cap (§7.4) and the flake policy (per-rep timeout + retries). A run is
// reproducible from its committed manifest plus the repo state.
//
// The loader validates shape and fills operational defaults; expanding the
// `scenarios` globs and resolving `configs` to dirs (and checking they exist) is
// the runner's job, mirroring the scenario/config loaders.

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

// Controlled dimension, not a knob (§3.3): clean = Memento is the only MCP
// server; crowded = Memento plus fixed stub servers for discoverability pressure.
export const ENVIRONMENTS = ['clean', 'crowded'] as const;

// Phase 1 pins the model (§1); a matrix dimension in V2. Kept as the default so
// manifests stay terse but every rep record still stamps it (§8.2).
export const DEFAULT_MODEL = 'claude-opus-4-8';
export const DEFAULT_CONCURRENCY = 2; // §7.2
export const DEFAULT_TIMEOUT_S = 600; // §7.4 per-rep 10-minute timeout
export const DEFAULT_RETRIES = 1; // §7.4 timed-out/crashed reps retried once

const nonEmpty = z.string().trim().min(1);
const slug = z.string().regex(/^[a-z0-9-]+$/, 'must be a kebab-case slug');
const positiveInt = z.number().int().positive();

export const manifestSchema = z
  .object({
    name: slug,
    model: nonEmpty.default(DEFAULT_MODEL),
    env: z.enum(ENVIRONMENTS).default('clean'),
    reps: positiveInt,
    concurrency: positiveInt.default(DEFAULT_CONCURRENCY),
    // Hard cap: the runner accumulates per-session cost and halts here (§7.4).
    // Required so a run can never be launched uncapped by omission.
    max_spend_usd: z.number().positive(),
    timeout_s: positiveInt.default(DEFAULT_TIMEOUT_S),
    retries: z.number().int().min(0).default(DEFAULT_RETRIES),
    configs: z.array(slug).min(1), // config names (dirs under configs/)
    scenarios: z.array(nonEmpty).min(1), // globs over scenario ids, e.g. "read/*"
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;

/** Parse and validate a run manifest, throwing a per-field error on failure. */
export function loadManifest(path: string): Manifest {
  const parsed = parseYaml(readFileSync(path, 'utf8')) as unknown;
  const result = manifestSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  ${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n');
    throw new Error(`Invalid manifest at ${path}:\n${issues}`);
  }
  // The run name identifies every record it produces (§8.2 "run"); keep it tied
  // to the filename so a renamed manifest can't quietly mislabel a results log.
  const expected = basename(path).replace(/\.ya?ml$/, '');
  if (result.data.name !== expected) {
    throw new Error(
      `Manifest name "${result.data.name}" does not match its file "${basename(path)}" (${path}).`,
    );
  }
  return result.data;
}

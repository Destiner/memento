import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

import { loadManifest, manifestSchema } from './manifest.js';

const HARNESS_ROOT = fileURLToPath(new URL('..', import.meta.url));

// A minimal manifest: only the required fields, so operational defaults show.
const MIN = {
  name: 'screening-1',
  reps: 3,
  max_spend_usd: 60,
  configs: ['baseline-0'],
  scenarios: ['read/*'],
};

describe('loadManifest', () => {
  test('loads the committed screening-1 manifest', () => {
    const manifest = loadManifest(`${HARNESS_ROOT}manifests/screening-1.yaml`);
    expect(manifest.name).toBe('screening-1');
    expect(manifest.model).toBe('claude-opus-4-8');
    expect(manifest.env).toBe('clean');
    expect(manifest.reps).toBe(3);
    expect(manifest.max_spend_usd).toBe(60);
    expect(manifest.configs).toContain('baseline-0');
    expect(manifest.scenarios).toEqual(['read/*', 'no-read/*']);
  });

  test('throws when manifest.name disagrees with the filename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'memento-manifest-'));
    const path = join(dir, 'run-a.yaml');
    writeFileSync(
      path,
      'name: run-b\nreps: 1\nmax_spend_usd: 5\nconfigs: [x]\nscenarios: ["y/*"]\n',
    );
    expect(() => loadManifest(path)).toThrow(/does not match its file/);
  });
});

describe('manifestSchema', () => {
  test('fills operational defaults from a minimal manifest', () => {
    const manifest = manifestSchema.parse(MIN);
    expect(manifest.model).toBe('claude-opus-4-8');
    expect(manifest.env).toBe('clean');
    expect(manifest.concurrency).toBe(2);
    expect(manifest.timeout_s).toBe(600);
    expect(manifest.retries).toBe(1);
  });

  test('rejects unknown fields (strict)', () => {
    expect(manifestSchema.safeParse({ ...MIN, oops: 1 }).success).toBe(false);
  });

  test('requires a positive spend cap', () => {
    expect(manifestSchema.safeParse({ ...MIN, max_spend_usd: undefined }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...MIN, max_spend_usd: 0 }).success).toBe(false);
  });

  test('requires at least one config and one scenario, and reps >= 1', () => {
    expect(manifestSchema.safeParse({ ...MIN, configs: [] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...MIN, scenarios: [] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...MIN, reps: 0 }).success).toBe(false);
  });

  test('rejects an unknown environment', () => {
    expect(manifestSchema.safeParse({ ...MIN, env: 'staging' }).success).toBe(false);
  });
});

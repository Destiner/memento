import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { type Config } from './config.js';
import { type Cell } from './plan.js';
import { buildRecord, configHash, UNSCORED } from './record.js';
import { type Scenario } from './scenario.js';

const CONFIG: Config = {
  name: 'baseline-0',
  knob: 'none',
  variant: 'none',
  side: 'both',
  portability: 'portable',
  memento_variant: 'plain',
};

const SCENARIO: Scenario = {
  id: 'read/email-provider',
  version: 3,
  class: 'should-retrieve',
  fixture: 'fixtures/saas-app',
  task: 'do it',
  corpus: 'corpus/standard-15',
  seeded_memory: 'corpus/facts/email-provider.md',
  checks: { utility_regex: '(?i)postmark' },
};

const CELL: Cell = { config: CONFIG, scenario: SCENARIO, rep: 2 };

describe('buildRecord', () => {
  test('assembles a §8.2 record with session facts and unscored placeholders', () => {
    const record = buildRecord({
      run: 'screening-1',
      timestamp: '2026-07-07T00:00:00Z',
      model: 'claude-opus-4-8',
      ccVersion: '1.6.9',
      mementoVersion: '0.1.0',
      env: 'clean',
      cell: CELL,
      configHash: 'sha256:abc',
      status: 'ok',
      session: { cost_usd: 0.42, duration_s: 141, turns: 9, tokens_in: 1050, tokens_out: 200 },
      scored: UNSCORED,
      transcriptPath: 'results/transcripts/screening-1/x.json',
    });
    expect(record.config).toBe('baseline-0');
    expect(record.scenario).toBe('read/email-provider');
    expect(record.scenario_version).toBe(3);
    expect(record.scenario_class).toBe('should-retrieve'); // persisted so the report never reconstructs it
    expect(record.rep).toBe(2);
    expect(record.status).toBe('ok');
    expect(record.raw.cost_usd).toBe(0.42);
    expect(record.raw.tokens_in).toBe(1050);
    expect(record.raw.utility_pass).toBeNull(); // filled by the scorer (§11.4)
  });
});

describe('configHash', () => {
  let dir: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-hash-'));
    writeFileSync(join(dir, 'meta.yaml'), 'name: c\n');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'frag.json'), '{}');
  });

  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  test('is deterministic across calls', () => {
    expect(configHash(dir)).toBe(configHash(dir));
    expect(configHash(dir)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test('changes when an artifact changes', () => {
    const before = configHash(dir);
    writeFileSync(join(dir, 'meta.yaml'), 'name: c\ndescription: edited\n');
    expect(configHash(dir)).not.toBe(before);
  });
});

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { runOracle } from './oracle.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'memento-oracle-'));
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('runOracle', () => {
  test('passes on exit 0', () => {
    expect(runOracle('exit 0', dir, 10)).toEqual({ passed: true, exitCode: 0, timedOut: false });
  });

  test('fails on a non-zero exit', () => {
    const result = runOracle('exit 3', dir, 10);
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(3);
    expect(result.timedOut).toBe(false);
  });

  test('runs in the given fixture directory', () => {
    runOracle('pwd > where.txt', dir, 10);
    // macOS symlinks /tmp → /private/tmp; compare basenames to stay portable.
    expect(readFileSync(join(dir, 'where.txt'), 'utf8').trim()).toContain(dir.split('/').pop()!);
  });

  test('reports a timeout as a non-pass', () => {
    const result = runOracle('sleep 5', dir, 0.05);
    expect(result.passed).toBe(false);
    expect(result.timedOut).toBe(true);
  });
});

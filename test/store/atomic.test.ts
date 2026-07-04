import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { atomicWrite, ensureDir } from '../../src/store/atomic.js';

describe('atomicWrite', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-atomic-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('creates missing parent directories and writes the file', async () => {
    const target = join(dir, 'nested', 'deep', 'memory.md');
    await atomicWrite(target, 'hello');
    expect(readFileSync(target, 'utf8')).toBe('hello');
  });

  test('overwrites an existing file', async () => {
    const target = join(dir, 'memory.md');
    writeFileSync(target, 'old');
    await atomicWrite(target, 'new');
    expect(readFileSync(target, 'utf8')).toBe('new');
  });

  test('leaves no temp files behind on success', async () => {
    const target = join(dir, 'memory.md');
    await atomicWrite(target, 'data');
    const leftovers = readdirSync(dir).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  test('concurrent writes to the same target leave complete content', async () => {
    const target = join(dir, 'memory.md');
    const a = 'A'.repeat(10_000);
    const b = 'B'.repeat(10_000);
    await Promise.all([atomicWrite(target, a), atomicWrite(target, b)]);
    const final = readFileSync(target, 'utf8');
    expect([a, b]).toContain(final);
    expect(readdirSync(dir).filter((n) => n.endsWith('.tmp'))).toEqual([]);
  });
});

describe('ensureDir', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-ensuredir-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('is idempotent', async () => {
    const target = join(dir, 'a', 'b');
    await ensureDir(target);
    await expect(ensureDir(target)).resolves.toBeUndefined();
  });
});

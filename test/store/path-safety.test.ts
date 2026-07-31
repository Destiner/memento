import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { assertInsideRoot, assertSafeMemoryId } from '../../src/store/path-safety.js';
import { rebuildIndex } from '../../src/store/rebuild.js';
import { resolveMemoryPath } from '../../src/store/memory-path.js';
import { MemoryIndex } from '../../src/store/search-index.js';

describe('assertSafeMemoryId', () => {
  test('accepts well-formed ids (including short example ids)', () => {
    expect(() => assertSafeMemoryId('mem_01JEXAMPLE000000000')).not.toThrow();
    expect(() => assertSafeMemoryId('mem_01J8KZ9Q7ABCDEF0123456789')).not.toThrow();
  });

  test.each([
    ['../etc/passwd'],
    ['mem_../../etc/passwd'],
    ['mem_a/b'],
    ['mem_a\\b'],
    ['mem_a.b'],
    ['mem_'],
    [''],
    ['notmem_0001'],
    ['mem_01J\0'],
  ])('rejects unsafe id %j', (id) => {
    expect(() => assertSafeMemoryId(id)).toThrow(MementoError);
  });
});

describe('path containment', () => {
  let root: string;
  let outside: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'memento-safe-root-'));
    outside = mkdtempSync(join(tmpdir(), 'memento-safe-out-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  test('assertInsideRoot passes for a real file inside the root', async () => {
    const file = join(root, 'mem_TEST0001-slug.md');
    writeFileSync(file, 'x');
    await expect(assertInsideRoot(root, file)).resolves.toBeUndefined();
  });

  test('assertInsideRoot rejects a symlink that escapes the root', async () => {
    const secret = join(outside, 'secret.md');
    writeFileSync(secret, 'top secret');
    const link = join(root, 'mem_TEST0001-slug.md');
    symlinkSync(secret, link);
    await expect(assertInsideRoot(root, link)).rejects.toMatchObject({ code: 'validation_error' });
  });

  test('resolveMemoryPath rejects an id whose file symlinks outside the root', async () => {
    const secret = join(outside, 'secret.md');
    writeFileSync(secret, 'top secret');
    symlinkSync(secret, join(root, 'mem_TEST0001-slug.md'));
    await expect(resolveMemoryPath(root, 'mem_TEST0001')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  test('resolveMemoryPath rejects a malformed id before touching the filesystem', async () => {
    await expect(resolveMemoryPath(root, '../../etc/passwd')).rejects.toMatchObject({
      code: 'validation_error',
    });
  });

  test('rebuildIndex skips a memory file that symlinks outside the root', async () => {
    // A legitimate memory alongside an escaping symlink: only the real one indexes.
    writeFileSync(
      join(root, 'mem_TEST0001-real.md'),
      [
        '---',
        'id: mem_TEST0001',
        'title: Real',
        'description: A real memory beside an escaping symlink.',
        'scope:',
        '  kind: global',
        'type: decision_history',
        'provenance:',
        '  source: agent_observed',
        '  verification: observed_once',
        'status: active',
        'created_at: 2026-07-01T00:00:00Z',
        'updated_at: 2026-07-01T00:00:00Z',
        '---',
        '',
        'body',
        '',
      ].join('\n'),
    );
    const secret = join(outside, 'secret.md');
    writeFileSync(secret, 'top secret');
    symlinkSync(secret, join(root, 'mem_TEST0002-escape.md'));

    const index = new MemoryIndex();
    try {
      const result = await rebuildIndex(index, root);
      expect(result.indexed).toBe(1);
      expect(result.skipped).toHaveLength(1);
      expect(result.skipped[0]!.file).toBe('mem_TEST0002-escape.md');
    } finally {
      index.close();
    }
  });
});

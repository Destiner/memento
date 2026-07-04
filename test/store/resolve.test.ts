import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { resolveMemoryPath } from '../../src/store/resolve.js';

describe('resolveMemoryPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-resolve-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('resolves the file whose name carries the id prefix', async () => {
    const file = 'mem_TEST0001-some-slug.md';
    writeFileSync(join(dir, file), 'x');
    await expect(resolveMemoryPath(dir, 'mem_TEST0001')).resolves.toBe(join(dir, file));
  });

  test('throws not_found when no file matches', async () => {
    writeFileSync(join(dir, 'mem_OTHER-slug.md'), 'x');
    await expect(resolveMemoryPath(dir, 'mem_TEST0001')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  test('throws not_found when the memories directory does not exist', async () => {
    await expect(resolveMemoryPath(join(dir, 'missing'), 'mem_TEST0001')).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  test('requires the trailing hyphen so one id is not a prefix of another', async () => {
    writeFileSync(join(dir, 'mem_TEST00019-slug.md'), 'x');
    await expect(resolveMemoryPath(dir, 'mem_TEST0001')).rejects.toBeInstanceOf(MementoError);
  });

  test('throws internal_error when multiple files share an id', async () => {
    writeFileSync(join(dir, 'mem_TEST0001-a.md'), 'x');
    writeFileSync(join(dir, 'mem_TEST0001-b.md'), 'x');
    await expect(resolveMemoryPath(dir, 'mem_TEST0001')).rejects.toMatchObject({
      code: 'internal_error',
    });
  });
});

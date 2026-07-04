import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { createMemory } from '../../src/store/create.js';
import { readMemory } from '../../src/store/read.js';

const seedInput = {
  title: 'ExampleEmailVendor: deliverability caveat',
  type: 'integration',
  scope: 'cross_project',
  body: '## Summary\nWebhooks lag at peak volume.',
};

describe('readMemory', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-read-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns the id, a metadata summary, and the full file text', async () => {
    await createMemory(seedInput, { memoriesDir: dir, makeId: () => 'mem_READ0001' });

    const result = await readMemory({ id: 'mem_READ0001' }, { memoriesDir: dir });

    expect(result.id).toBe('mem_READ0001');
    expect(result.metadata).toEqual({
      title: seedInput.title,
      type: 'integration',
      scope: 'cross_project',
      status: 'active',
    });
    expect(result.markdown).toContain('---');
    expect(result.markdown).toContain('id: mem_READ0001');
    expect(result.markdown).toContain('## Summary\nWebhooks lag at peak volume.');
  });

  test('throws not_found for an unknown id', async () => {
    await expect(readMemory({ id: 'mem_MISSING' }, { memoriesDir: dir })).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  test('rejects a corrupt on-disk record', async () => {
    writeFileSync(join(dir, 'mem_BROKEN-x.md'), '---\ntype: nonsense\n---\n\nbody\n');
    await expect(readMemory({ id: 'mem_BROKEN' }, { memoriesDir: dir })).rejects.toBeInstanceOf(
      MementoError,
    );
  });

  test('rejects unknown input keys', async () => {
    await expect(
      readMemory({ id: 'mem_READ0001', version: 2 }, { memoriesDir: dir }),
    ).rejects.toBeInstanceOf(MementoError);
  });
});

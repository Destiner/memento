import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { rebuildIndex } from '../../src/store/rebuild.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { memoryRecord } from '../helpers/memories.js';

const FIXTURES = fileURLToPath(new URL('../fixtures/memories', import.meta.url));

// The projects the fixture memories are scoped to.
const FIXTURE_SCOPE = {
  kind: 'projects' as const,
  project_ids: ['prj_01JEXAMPLEPRJ000001', 'prj_01JEXAMPLEPRJ000002'],
};

describe('rebuildIndex', () => {
  let dir: string;
  let index: MemoryIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-rebuild-'));
    cpSync(FIXTURES, dir, { recursive: true });
    index = new MemoryIndex();
  });

  afterEach(() => {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('indexes every valid memory on disk', async () => {
    const result = await rebuildIndex(index, dir);

    expect(result.indexed).toBe(3);
    expect(result.skipped).toEqual([]);
    expect(index.count()).toBe(3);
    expect(index.search('legacy sync', { limit: 5, scope: FIXTURE_SCOPE }).length).toBeGreaterThan(
      0,
    );
  });

  test('is idempotent: a second rebuild does not duplicate rows', async () => {
    await rebuildIndex(index, dir);
    await rebuildIndex(index, dir);

    expect(index.count()).toBe(3);
  });

  test('replaces stale index contents from the current markdown', async () => {
    index.upsert(
      memoryRecord({ id: 'mem_STALE0001', title: 'Stale ghost', scope: { kind: 'global' } }),
      'no longer on disk',
    );

    await rebuildIndex(index, dir);

    expect(index.count()).toBe(3);
    expect(index.search('ghost', { limit: 5, scope: { kind: 'global' } })).toHaveLength(0);
  });

  test('skips corrupt files but indexes the rest', async () => {
    writeFileSync(join(dir, 'mem_BROKEN-x.md'), '---\ntype: nonsense\n---\n\nbody\n');

    const result = await rebuildIndex(index, dir);

    expect(result.indexed).toBe(3);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.file).toBe('mem_BROKEN-x.md');
    expect(index.count()).toBe(3);
  });

  test('a missing memories directory yields an empty index', async () => {
    const result = await rebuildIndex(index, join(dir, 'does-not-exist'));

    expect(result.indexed).toBe(0);
    expect(index.count()).toBe(0);
  });
});

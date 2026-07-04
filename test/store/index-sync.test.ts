import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createMemory } from '../../src/store/create.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { updateMemory } from '../../src/store/update.js';

const input = {
  title: 'Billing service map',
  type: 'relationship' as const,
  scope: 'cross_project' as const,
  body: '## Summary\nThe billing service calls the customer portal over gRPC.',
  entities: ['billing-service'],
};

describe('incremental index sync', () => {
  let dir: string;
  let index: MemoryIndex;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-sync-'));
    index = new MemoryIndex();
  });

  afterEach(() => {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('create_memory makes a memory searchable immediately', async () => {
    await createMemory(input, { memoriesDir: dir, index, makeId: () => 'mem_SYNC0001' });

    const hits = index.search('billing portal grpc', { limit: 5 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('mem_SYNC0001');
  });

  test('update_memory re-indexes the edited body in place', async () => {
    await createMemory(input, { memoriesDir: dir, index, makeId: () => 'mem_SYNC0002' });
    await updateMemory(
      { id: 'mem_SYNC0002', old_text: 'over gRPC', new_text: 'over a REST webhook' },
      { memoriesDir: dir, index },
    );

    expect(index.count()).toBe(1);
    expect(index.search('webhook', { limit: 5 })).toHaveLength(1);
    expect(index.search('grpc', { limit: 5 })).toHaveLength(0);
  });
});

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import type { SearchOptions } from '../../src/store/search-index.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { memoryRecord, PROJECT_A, PROJECT_B } from '../helpers/memories.js';

// A shared corpus all touching "retry" so the lexical query never filters them.
const BODY = 'Retry policy notes for the service.';

describe('search filtering', () => {
  let index: MemoryIndex;

  beforeEach(() => {
    index = new MemoryIndex();
    index.upsert(
      memoryRecord({
        id: 'mem_A',
        title: 'Retry behaviour in Alpha',
        type: 'debugging_pattern',
        scope: { kind: 'projects', project_ids: [PROJECT_A] },
      }),
      BODY,
    );
    index.upsert(
      memoryRecord({
        id: 'mem_B',
        title: 'Retry behaviour in Beta',
        type: 'decision_history',
        status: 'archived',
        archive_reason: 'Retries were removed.',
        scope: { kind: 'projects', project_ids: [PROJECT_B] },
      }),
      BODY,
    );
    index.upsert(
      memoryRecord({
        id: 'mem_BOTH',
        title: 'Retry behaviour across both',
        type: 'cross_project_context',
        scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] },
      }),
      BODY,
    );
    index.upsert(
      memoryRecord({
        id: 'mem_GLOBAL',
        title: 'Retry conventions the user prefers',
        type: 'preference',
        scope: { kind: 'global' },
      }),
      BODY,
    );
  });

  afterEach(() => index.close());

  const ids = (options: SearchOptions) =>
    index
      .search('retry', options)
      .map((hit) => hit.id)
      .sort();

  test('scope is required and never widens', () => {
    expect(ids({ limit: 10, scope: { kind: 'global' } })).toEqual(['mem_GLOBAL']);
    expect(ids({ limit: 10, scope: { kind: 'projects', project_ids: [PROJECT_A] } })).toEqual([
      'mem_A',
      'mem_BOTH',
    ]);
  });

  test('any (the default) matches either supplied project', () => {
    expect(
      ids({ limit: 10, scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] } }),
    ).toEqual(['mem_A', 'mem_B', 'mem_BOTH']);
  });

  test('all matches only memories carrying every supplied project', () => {
    expect(
      ids({
        limit: 10,
        scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B], match: 'all' },
      }),
    ).toEqual(['mem_BOTH']);
  });

  test('all with a single project still matches memories that carry more', () => {
    expect(
      ids({ limit: 10, scope: { kind: 'projects', project_ids: [PROJECT_A], match: 'all' } }),
    ).toEqual(['mem_A', 'mem_BOTH']);
  });

  test('filters by type (OR within the category)', () => {
    expect(
      ids({
        limit: 10,
        scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] },
        types: ['decision_history', 'cross_project_context'],
      }),
    ).toEqual(['mem_B', 'mem_BOTH']);
  });

  test('filters by status', () => {
    expect(
      ids({
        limit: 10,
        scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] },
        status: ['active'],
      }),
    ).toEqual(['mem_A', 'mem_BOTH']);
  });

  test('combines categories with AND', () => {
    expect(
      ids({
        limit: 10,
        scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] },
        status: ['active'],
        types: ['cross_project_context'],
      }),
    ).toEqual(['mem_BOTH']);
  });
});

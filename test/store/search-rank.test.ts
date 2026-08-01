import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MemoryIndex } from '../../src/store/search-index.js';
import { memoryRecord, PROJECT_A } from '../helpers/memories.js';

const SCOPE = { kind: 'projects' as const, project_ids: [PROJECT_A] };

describe('search ranking', () => {
  let index: MemoryIndex;

  beforeEach(() => {
    index = new MemoryIndex();
  });

  afterEach(() => index.close());

  const ids = (query: string, status?: ('active' | 'archived')[]) =>
    index.search(query, { limit: 5, scope: SCOPE, status }).map((hit) => hit.id);

  test('active memories rank above archived ones with equal lexical match', () => {
    index.upsert(
      memoryRecord({ id: 'mem_OLD', status: 'archived', archive_reason: 'Superseded.' }),
      'payment retry policy',
    );
    index.upsert(memoryRecord({ id: 'mem_NEW' }), 'payment retry policy');

    const ranked = ids('payment retry', ['active', 'archived']);
    expect(ranked.indexOf('mem_NEW')).toBeLessThan(ranked.indexOf('mem_OLD'));
  });

  test('a title match outranks a body-only match', () => {
    index.upsert(
      memoryRecord({ id: 'mem_BODY', title: 'General notes', description: 'Assorted notes.' }),
      'discusses webhook retries',
    );
    index.upsert(
      memoryRecord({
        id: 'mem_TITLE',
        title: 'Webhook retry policy',
        description: 'Assorted notes.',
      }),
      'general notes',
    );

    expect(ids('webhook retry')[0]).toBe('mem_TITLE');
  });

  // Description is the other short, curated field and receives a ranking boost.
  test('a description match boosts a memory', () => {
    index.upsert(
      memoryRecord({ id: 'mem_PLAIN', title: 'Notes', description: 'Assorted notes.' }),
      'stripe integration notes here',
    );
    index.upsert(
      memoryRecord({
        id: 'mem_DESC',
        title: 'Notes',
        description: 'How the stripe integration behaves.',
      }),
      'stripe integration notes here',
    );

    expect(ids('stripe')[0]).toBe('mem_DESC');
  });

  // Unverified memories receive a ranking penalty.
  test('unverified memories rank below established ones', () => {
    index.upsert(
      memoryRecord({
        id: 'mem_GUESS',
        provenance: { source: 'inferred', verification: 'unverified' },
      }),
      'cache invalidation notes',
    );
    index.upsert(
      memoryRecord({
        id: 'mem_SEEN',
        provenance: { source: 'agent_observed', verification: 'observed_once' },
      }),
      'cache invalidation notes',
    );

    const ranked = ids('cache invalidation');
    expect(ranked.indexOf('mem_SEEN')).toBeLessThan(ranked.indexOf('mem_GUESS'));
  });

  test('recency breaks ties between otherwise equal memories', () => {
    index.upsert(
      memoryRecord({ id: 'mem_OLDER', updated_at: '2026-01-01T00:00:00Z' }),
      'idempotency key handling',
    );
    index.upsert(
      memoryRecord({ id: 'mem_NEWER', updated_at: '2026-06-01T00:00:00Z' }),
      'idempotency key handling',
    );

    expect(ids('idempotency key')[0]).toBe('mem_NEWER');
  });

  test('scores stay within [0, 1]', () => {
    index.upsert(
      memoryRecord({
        id: 'mem_MAX',
        title: 'stripe webhook retry',
        description: 'stripe webhook retry behaviour',
      }),
      'stripe webhook retry',
    );

    const [hit] = index.search('stripe webhook retry', { limit: 5, scope: SCOPE });
    expect(hit!.score).toBeGreaterThan(0);
    expect(hit!.score).toBeLessThanOrEqual(1);
  });
});

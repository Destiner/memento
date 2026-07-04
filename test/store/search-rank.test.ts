import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MemoryIndex } from '../../src/store/search-index.js';
import type { MemoryMetadata } from '../../src/store/schema.js';

function memory(overrides: Partial<MemoryMetadata>): MemoryMetadata {
  return {
    id: 'mem_0000',
    title: 'Notes',
    type: 'decision',
    scope: 'project',
    status: 'active',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('search ranking', () => {
  let index: MemoryIndex;

  beforeEach(() => {
    index = new MemoryIndex();
  });

  afterEach(() => index.close());

  test('active memories rank above superseded ones with equal lexical match', () => {
    index.upsert(memory({ id: 'mem_OLD', status: 'superseded' }), 'payment retry policy');
    index.upsert(memory({ id: 'mem_NEW', status: 'active' }), 'payment retry policy');

    const ids = index.search('payment retry', { limit: 5 }).map((h) => h.id);
    expect(ids.indexOf('mem_NEW')).toBeLessThan(ids.indexOf('mem_OLD'));
  });

  test('a title match outranks a body-only match', () => {
    index.upsert(memory({ id: 'mem_BODY', title: 'General notes' }), 'discusses webhook retries');
    index.upsert(memory({ id: 'mem_TITLE', title: 'Webhook retry policy' }), 'general notes');

    const ids = index.search('webhook retry', { limit: 5 }).map((h) => h.id);
    expect(ids[0]).toBe('mem_TITLE');
  });

  test('an exact entity match boosts a memory', () => {
    index.upsert(memory({ id: 'mem_PLAIN' }), 'stripe integration notes here');
    index.upsert(
      memory({ id: 'mem_ENTITY', entities: ['stripe'] }),
      'stripe integration notes here',
    );

    const ids = index.search('stripe', { limit: 5 }).map((h) => h.id);
    expect(ids[0]).toBe('mem_ENTITY');
  });

  test('archived memories are penalised more heavily than superseded', () => {
    index.upsert(memory({ id: 'mem_SUP', status: 'superseded' }), 'cache invalidation notes');
    index.upsert(memory({ id: 'mem_ARC', status: 'archived' }), 'cache invalidation notes');

    const ids = index.search('cache invalidation', { limit: 5 }).map((h) => h.id);
    expect(ids.indexOf('mem_SUP')).toBeLessThan(ids.indexOf('mem_ARC'));
  });

  test('recency breaks ties between otherwise equal memories', () => {
    index.upsert(
      memory({ id: 'mem_OLDER', updated_at: '2026-01-01T00:00:00Z' }),
      'idempotency key handling',
    );
    index.upsert(
      memory({ id: 'mem_NEWER', updated_at: '2026-06-01T00:00:00Z' }),
      'idempotency key handling',
    );

    const ids = index.search('idempotency key', { limit: 5 }).map((h) => h.id);
    expect(ids[0]).toBe('mem_NEWER');
  });

  test('scores stay within [0, 1]', () => {
    index.upsert(
      memory({ id: 'mem_MAX', title: 'stripe webhook', entities: ['stripe'], importance: 'high' }),
      'stripe webhook retry',
    );

    const [hit] = index.search('stripe webhook retry', { limit: 5 });
    expect(hit!.score).toBeGreaterThan(0);
    expect(hit!.score).toBeLessThanOrEqual(1);
  });
});

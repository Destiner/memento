import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { searchMemory } from '../../src/store/search.js';
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

const opts = (index: MemoryIndex) => ({
  index,
  defaultLimit: 5,
  maxLimit: 10,
  makeQueryId: () => 'qry_TEST',
});

describe('searchMemory', () => {
  let index: MemoryIndex;

  beforeEach(() => {
    index = new MemoryIndex();
    index.upsert(
      memory({
        id: 'mem_EMAIL',
        title: 'ExampleEmailVendor deliverability',
        type: 'integration',
        entities: ['ExampleEmailVendor'],
        projects: ['marketing-api'],
        tags: ['deliverability'],
      }),
      'Webhook delivery can be delayed at peak volume.',
    );
    index.upsert(
      memory({ id: 'mem_OTHER', title: 'Cache strategy' }),
      'Notes on cache invalidation.',
    );
  });

  afterEach(() => index.close());

  test('returns a query id, results, and a count', () => {
    const result = searchMemory({ query: 'webhook delivery' }, opts(index));

    expect(result.query_id).toBe('qry_TEST');
    expect(result.result_count).toBe(1);
    expect(result.results[0]!.id).toBe('mem_EMAIL');
    expect(result.results[0]!.score).toBeGreaterThan(0);
    expect(result.results[0]!.excerpt).toContain('delivery');
  });

  test('why_relevant explains entity and project matches', () => {
    const result = searchMemory({ query: 'ExampleEmailVendor marketing-api' }, opts(index));

    const why = result.results[0]!.why_relevant;
    expect(why.some((w) => w.includes('matched entity: ExampleEmailVendor'))).toBe(true);
    expect(why.some((w) => w.includes('matched project: marketing-api'))).toBe(true);
  });

  test('why_relevant is never empty', () => {
    const result = searchMemory({ query: 'webhook' }, opts(index));
    expect(result.results[0]!.why_relevant.length).toBeGreaterThan(0);
  });

  test('clamps the limit to the configured maximum', () => {
    for (let i = 0; i < 15; i++) {
      index.upsert(memory({ id: `mem_BULK${i}`, title: `webhook note ${i}` }), 'webhook body');
    }

    const result = searchMemory({ query: 'webhook', limit: 50 }, opts(index));
    expect(result.results.length).toBeLessThanOrEqual(10);
  });

  test('honours a smaller requested limit', () => {
    for (let i = 0; i < 5; i++) {
      index.upsert(memory({ id: `mem_SMALL${i}`, title: `webhook note ${i}` }), 'webhook body');
    }

    const result = searchMemory({ query: 'webhook', limit: 2 }, opts(index));
    expect(result.results).toHaveLength(2);
  });

  test('omits excerpts when include_excerpt is false', () => {
    const result = searchMemory({ query: 'webhook delivery', include_excerpt: false }, opts(index));
    expect(result.results[0]!.excerpt).toBeUndefined();
  });

  test('applies structured filters', () => {
    const result = searchMemory({ query: 'webhook cache', types: ['integration'] }, opts(index));
    expect(result.results.every((r) => r.type === 'integration')).toBe(true);
  });

  test('rejects an empty query', () => {
    expect(() => searchMemory({ query: '' }, opts(index))).toThrow(MementoError);
  });

  test('rejects unknown input keys', () => {
    expect(() => searchMemory({ query: 'x', bogus: 1 }, opts(index))).toThrow(MementoError);
  });
});

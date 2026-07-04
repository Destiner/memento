import { describe, expect, test } from 'vitest';

import { MemoryIndex, normalizeBm25, toMatchQuery } from '../../src/store/search-index.js';
import type { MemoryMetadata } from '../../src/store/schema.js';

function memory(overrides: Partial<MemoryMetadata> = {}): MemoryMetadata {
  return {
    id: 'mem_INDEX0001',
    title: 'ExampleEmailVendor: deliverability caveat',
    type: 'integration',
    scope: 'cross_project',
    status: 'active',
    created_at: '2026-06-18T09:30:00Z',
    updated_at: '2026-06-20T11:00:00Z',
    entities: ['ExampleEmailVendor'],
    tags: ['deliverability'],
    ...overrides,
  };
}

const BODY = '## Summary\nWebhook delivery can be delayed during peak volume.';

describe('MemoryIndex', () => {
  test('indexes a memory and finds it by a body term', () => {
    const index = new MemoryIndex();
    index.upsert(memory(), BODY);

    const hits = index.search('webhook delivery', { limit: 5 });

    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('mem_INDEX0001');
    expect(hits[0]!.entities).toEqual(['ExampleEmailVendor']);
    expect(hits[0]!.score).toBeGreaterThan(0);
    expect(hits[0]!.excerpt.toLowerCase()).toContain('delivery');
    index.close();
  });

  test('porter stemming matches inflected forms', () => {
    const index = new MemoryIndex();
    index.upsert(memory(), BODY);

    expect(index.search('delay', { limit: 5 })).toHaveLength(1);
    index.close();
  });

  test('upsert is idempotent on id', () => {
    const index = new MemoryIndex();
    index.upsert(memory(), BODY);
    index.upsert(memory({ title: 'Updated title' }), BODY);

    expect(index.count()).toBe(1);
    expect(index.search('updated', { limit: 5 })).toHaveLength(1);
    index.close();
  });

  test('remove deletes from the index', () => {
    const index = new MemoryIndex();
    index.upsert(memory(), BODY);
    index.remove('mem_INDEX0001');

    expect(index.count()).toBe(0);
    expect(index.search('webhook', { limit: 5 })).toHaveLength(0);
    index.close();
  });

  test('clear drops all rows but keeps the schema usable', () => {
    const index = new MemoryIndex();
    index.upsert(memory(), BODY);
    index.clear();

    expect(index.count()).toBe(0);
    index.upsert(memory(), BODY);
    expect(index.count()).toBe(1);
    index.close();
  });

  test('honours the result limit', () => {
    const index = new MemoryIndex();
    for (let i = 0; i < 5; i++) {
      index.upsert(memory({ id: `mem_LIMIT000${i}` }), BODY);
    }

    expect(index.search('webhook', { limit: 3 })).toHaveLength(3);
    index.close();
  });

  test('termless queries return no results instead of erroring', () => {
    const index = new MemoryIndex();
    index.upsert(memory(), BODY);

    expect(index.search('   ', { limit: 5 })).toEqual([]);
    expect(index.search('a', { limit: 5 })).toEqual([]);
    index.close();
  });

  test('quotes terms so query punctuation cannot break the MATCH', () => {
    const index = new MemoryIndex();
    index.upsert(memory(), BODY);

    expect(() => index.search('delivery AND (peak', { limit: 5 })).not.toThrow();
    index.close();
  });
});

describe('toMatchQuery', () => {
  test('lowercases, drops single chars, and ORs quoted terms', () => {
    expect(toMatchQuery('Email delivery x')).toBe('"email" OR "delivery"');
  });

  test('returns null when nothing usable remains', () => {
    expect(toMatchQuery('  , . a ')).toBeNull();
  });
});

describe('normalizeBm25', () => {
  test('maps more-negative scores to higher relevance in (0,1)', () => {
    expect(normalizeBm25(0)).toBe(0);
    expect(normalizeBm25(-1)).toBeCloseTo(0.5);
    expect(normalizeBm25(-9)).toBeCloseTo(0.9);
  });
});

import { describe, expect, test } from 'vitest';

import { MemoryIndex, normalizeBm25, toMatchQuery } from '../../src/store/search-index.js';
import { memoryRecord, PROJECT_A, PROJECT_B } from '../helpers/memories.js';

const SCOPE = { kind: 'projects' as const, project_ids: [PROJECT_A] };
const BODY = 'Webhook delivery can be delayed during peak volume.';

describe('MemoryIndex', () => {
  test('indexes a memory and finds it by a body term', () => {
    const index = new MemoryIndex();
    index.upsert(memoryRecord({ id: 'mem_INDEX0001' }), BODY);

    const hits = index.search('webhook delivery', { limit: 5, scope: SCOPE });

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: 'mem_INDEX0001',
      type: 'debugging_pattern',
      status: 'active',
      source: 'agent_observed',
      verification: 'observed_once',
      scope: { kind: 'projects', project_ids: [PROJECT_A] },
    });
    expect(hits[0]!.score).toBeGreaterThan(0);
    index.close();
  });

  test('finds a memory by a description term', () => {
    const index = new MemoryIndex();
    index.upsert(
      memoryRecord({ id: 'mem_DESC0001', description: 'Vendor throttling under sustained load.' }),
      BODY,
    );

    expect(index.search('throttling', { limit: 5, scope: SCOPE })).toHaveLength(1);
    index.close();
  });

  test('porter stemming matches inflected forms', () => {
    const index = new MemoryIndex();
    index.upsert(memoryRecord({ id: 'mem_INDEX0002' }), BODY);

    expect(index.search('delay', { limit: 5, scope: SCOPE })).toHaveLength(1);
    index.close();
  });

  test('upsert is idempotent on id', () => {
    const index = new MemoryIndex();
    index.upsert(memoryRecord({ id: 'mem_INDEX0003' }), BODY);
    index.upsert(memoryRecord({ id: 'mem_INDEX0003', title: 'Updated title' }), BODY);

    expect(index.count()).toBe(1);
    expect(index.search('updated', { limit: 5, scope: SCOPE })).toHaveLength(1);
    index.close();
  });

  test('remove deletes from the index', () => {
    const index = new MemoryIndex();
    index.upsert(memoryRecord({ id: 'mem_INDEX0004' }), BODY);
    index.remove('mem_INDEX0004');

    expect(index.count()).toBe(0);
    expect(index.search('webhook', { limit: 5, scope: SCOPE })).toHaveLength(0);
    index.close();
  });

  test('clear drops all rows but keeps the schema usable', () => {
    const index = new MemoryIndex();
    index.upsert(memoryRecord({ id: 'mem_INDEX0005' }), BODY);
    index.clear();

    expect(index.count()).toBe(0);
    index.upsert(memoryRecord({ id: 'mem_INDEX0005' }), BODY);
    expect(index.count()).toBe(1);
    index.close();
  });

  test('honours the result limit', () => {
    const index = new MemoryIndex();
    for (let i = 0; i < 5; i++) {
      index.upsert(memoryRecord({ id: `mem_LIMIT000${i}` }), BODY);
    }

    expect(index.search('webhook', { limit: 3, scope: SCOPE })).toHaveLength(3);
    index.close();
  });

  test('termless queries return no results instead of erroring', () => {
    const index = new MemoryIndex();
    index.upsert(memoryRecord(), BODY);

    expect(index.search('   ', { limit: 5, scope: SCOPE })).toEqual([]);
    expect(index.search('a', { limit: 5, scope: SCOPE })).toEqual([]);
    index.close();
  });

  test('quotes terms so query punctuation cannot break the MATCH', () => {
    const index = new MemoryIndex();
    index.upsert(memoryRecord(), BODY);

    expect(() => index.search('delivery AND (peak', { limit: 5, scope: SCOPE })).not.toThrow();
    index.close();
  });

  test('a global memory round-trips its scope', () => {
    const index = new MemoryIndex();
    index.upsert(memoryRecord({ id: 'mem_GLOBAL01', scope: { kind: 'global' } }), BODY);

    const [hit] = index.search('webhook', { limit: 5, scope: { kind: 'global' } });
    expect(hit!.scope).toEqual({ kind: 'global' });
    index.close();
  });
});

describe('MemoryIndex.candidates', () => {
  test('returns same-scope neighbours regardless of status', () => {
    const index = new MemoryIndex();
    index.upsert(memoryRecord({ id: 'mem_ACTIVE01' }), BODY);
    index.upsert(
      memoryRecord({
        id: 'mem_ARCHIVE1',
        status: 'archived',
        archive_reason: 'Superseded.',
      }),
      BODY,
    );

    const pool = index.candidates({
      title: 'Webhook retries duplicate sends under load',
      description: 'The provider delays webhooks at peak volume.',
      scope: SCOPE,
    });

    expect(pool.map((entry) => entry.id).sort()).toEqual(['mem_ACTIVE01', 'mem_ARCHIVE1']);
    index.close();
  });

  test('does not cross scopes', () => {
    const index = new MemoryIndex();
    index.upsert(
      memoryRecord({ id: 'mem_OTHER', scope: { kind: 'projects', project_ids: [PROJECT_B] } }),
      BODY,
    );
    index.upsert(memoryRecord({ id: 'mem_GLOBAL02', scope: { kind: 'global' } }), BODY);

    const pool = index.candidates({
      title: 'Webhook retries duplicate sends under load',
      description: 'The provider delays webhooks at peak volume.',
      scope: SCOPE,
    });

    expect(pool).toEqual([]);
    index.close();
  });

  test('an untokenizable draft yields no candidates rather than erroring', () => {
    const index = new MemoryIndex();
    index.upsert(memoryRecord(), BODY);

    expect(index.candidates({ title: '!', description: '?', scope: SCOPE })).toEqual([]);
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

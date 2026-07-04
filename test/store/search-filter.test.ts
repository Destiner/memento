import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MemoryIndex } from '../../src/store/search-index.js';
import type { MemoryMetadata } from '../../src/store/schema.js';

function memory(overrides: Partial<MemoryMetadata>): MemoryMetadata {
  return {
    id: 'mem_0000',
    title: 'Retry behaviour',
    type: 'integration',
    scope: 'cross_project',
    status: 'active',
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  };
}

// A shared corpus all touching "retry" so the lexical query never filters them.
const BODY = 'Retry policy notes for the service.';

describe('search filtering', () => {
  let index: MemoryIndex;

  beforeEach(() => {
    index = new MemoryIndex();
    index.upsert(
      memory({
        id: 'mem_A',
        type: 'integration',
        scope: 'external_tooling',
        status: 'active',
        projects: ['marketing-api'],
        entities: ['ExampleEmailVendor'],
        tags: ['deliverability'],
      }),
      BODY,
    );
    index.upsert(
      memory({
        id: 'mem_B',
        type: 'incident_learning',
        scope: 'cross_project',
        status: 'superseded',
        projects: ['billing'],
        entities: ['Stripe'],
        tags: ['webhooks'],
      }),
      BODY,
    );
    index.upsert(
      memory({
        id: 'mem_C',
        type: 'decision',
        scope: 'product',
        status: 'active',
        projects: ['marketing-api', 'billing'],
        entities: ['Stripe', 'ExampleEmailVendor'],
        tags: ['deliverability', 'webhooks'],
      }),
      BODY,
    );
  });

  afterEach(() => index.close());

  const ids = (opts: Parameters<MemoryIndex['search']>[1]) =>
    index
      .search('retry', opts)
      .map((h) => h.id)
      .sort();

  test('no filters returns the whole matching corpus', () => {
    expect(ids({ limit: 10 })).toEqual(['mem_A', 'mem_B', 'mem_C']);
  });

  test('filters by type (OR within category)', () => {
    expect(ids({ limit: 10, types: ['decision', 'incident_learning'] })).toEqual([
      'mem_B',
      'mem_C',
    ]);
  });

  test('filters by scope', () => {
    expect(ids({ limit: 10, scopes: ['product'] })).toEqual(['mem_C']);
  });

  test('filters by status', () => {
    expect(ids({ limit: 10, status: ['active'] })).toEqual(['mem_A', 'mem_C']);
  });

  test('filters by project membership', () => {
    expect(ids({ limit: 10, project: 'marketing-api' })).toEqual(['mem_A', 'mem_C']);
  });

  test('filters by entity (any match)', () => {
    expect(ids({ limit: 10, entities: ['Stripe'] })).toEqual(['mem_B', 'mem_C']);
  });

  test('filters by tag', () => {
    expect(ids({ limit: 10, tags: ['deliverability'] })).toEqual(['mem_A', 'mem_C']);
  });

  test('combines categories with AND', () => {
    expect(ids({ limit: 10, status: ['active'], entities: ['Stripe'] })).toEqual(['mem_C']);
  });
});

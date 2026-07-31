import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { searchMemories } from '../../src/store/memory-search.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { memoryRecord, PROJECT_A, PROJECT_B, seedProjects } from '../helpers/memories.js';

const PROJECTS = { kind: 'projects' as const, project_ids: [PROJECT_A] };

describe('searchMemories', () => {
  let home: string;
  let projectsDir: string;
  let index: MemoryIndex;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'memento-search-'));
    projectsDir = join(home, 'projects');
    index = new MemoryIndex();
    await seedProjects(projectsDir);

    index.upsert(
      memoryRecord({
        id: 'mem_EMAIL',
        title: 'Webhook delivery lags at peak volume',
        description: 'The email vendor delays webhook events under load.',
      }),
      'Webhook delivery can be delayed at peak volume.',
    );
    index.upsert(
      memoryRecord({
        id: 'mem_CACHE',
        title: 'Cache invalidation strategy',
        description: 'Why the cache is invalidated on write rather than on read.',
        type: 'decision_history',
      }),
      'Notes on cache invalidation.',
    );
  });

  afterEach(() => {
    index.close();
    rmSync(home, { recursive: true, force: true });
  });

  function opts(overrides: Record<string, unknown> = {}) {
    return {
      index,
      projectsDir,
      defaultLimit: 5,
      maxLimit: 10,
      makeQueryId: () => 'qry_TEST',
      ...overrides,
    };
  }

  test('returns a query id, lightweight summaries, and a count', async () => {
    const result = await searchMemories({ query: 'webhook delivery', scope: PROJECTS }, opts());

    expect(result.query_id).toBe('qry_TEST');
    expect(result.result_count).toBe(1);
    expect(result.results[0]).toEqual({
      id: 'mem_EMAIL',
      title: 'Webhook delivery lags at peak volume',
      description: 'The email vendor delays webhook events under load.',
      scope: { kind: 'projects', project_ids: [PROJECT_A] },
      type: 'debugging_pattern',
      status: 'active',
      updated_at: '2026-06-01T00:00:00Z',
      score: expect.any(Number),
    });
  });

  // The lightweight-result contract: the body and provenance are get_memory's job.
  test('never returns a body, provenance, or an excerpt', async () => {
    const result = await searchMemories({ query: 'webhook delivery', scope: PROJECTS }, opts());

    expect(result.results[0]).not.toHaveProperty('body');
    expect(result.results[0]).not.toHaveProperty('provenance');
    expect(result.results[0]).not.toHaveProperty('excerpt');
    expect(result.results[0]).not.toHaveProperty('why_relevant');
  });

  test('clamps the limit to the configured maximum', async () => {
    for (let i = 0; i < 15; i++) {
      index.upsert(
        memoryRecord({ id: `mem_BULK${i}`, title: `webhook note ${i}` }),
        'webhook body',
      );
    }

    const result = await searchMemories({ query: 'webhook', scope: PROJECTS, limit: 50 }, opts());
    expect(result.results.length).toBeLessThanOrEqual(10);
  });

  test('honours a smaller requested limit', async () => {
    for (let i = 0; i < 5; i++) {
      index.upsert(
        memoryRecord({ id: `mem_SMALL${i}`, title: `webhook note ${i}` }),
        'webhook body',
      );
    }

    const result = await searchMemories({ query: 'webhook', scope: PROJECTS, limit: 2 }, opts());
    expect(result.results).toHaveLength(2);
  });

  test('applies the type filter', async () => {
    const result = await searchMemories(
      { query: 'webhook cache', scope: PROJECTS, types: ['decision_history'] },
      opts(),
    );

    expect(result.results.map((r) => r.id)).toEqual(['mem_CACHE']);
  });

  test('rejects a project id no project answers to', async () => {
    await expect(
      searchMemories(
        { query: 'webhook', scope: { kind: 'projects', project_ids: ['prj_GHOST'] } },
        opts(),
      ),
    ).rejects.toMatchObject({ code: 'not_found', details: { unknown_ids: ['prj_GHOST'] } });
  });

  test('a projects search never returns global memories', async () => {
    index.upsert(
      memoryRecord({
        id: 'mem_PREF',
        title: 'Webhook conventions the user prefers',
        description: 'Always log webhook payload ids.',
        type: 'preference',
        scope: { kind: 'global' },
      }),
      'webhook conventions',
    );

    const scoped = await searchMemories({ query: 'webhook', scope: PROJECTS }, opts());
    expect(scoped.results.map((r) => r.id)).not.toContain('mem_PREF');

    const global = await searchMemories({ query: 'webhook', scope: { kind: 'global' } }, opts());
    expect(global.results.map((r) => r.id)).toEqual(['mem_PREF']);
  });

  describe('multi-project matching', () => {
    beforeEach(() => {
      index.upsert(
        memoryRecord({
          id: 'mem_BOTH',
          title: 'Onboarding spans both services',
          description: 'Alpha and Beta jointly implement onboarding.',
          type: 'cross_project_context',
          scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] },
        }),
        'onboarding crosses both services',
      );
      index.upsert(
        memoryRecord({
          id: 'mem_BETA',
          title: 'Onboarding retry defaults in Beta',
          description: 'Beta retries onboarding callbacks twice.',
          scope: { kind: 'projects', project_ids: [PROJECT_B] },
        }),
        'onboarding retries',
      );
    });

    test('any (the default) matches a memory on either project', async () => {
      const result = await searchMemories(
        { query: 'onboarding', scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] } },
        opts(),
      );

      expect(result.results.map((r) => r.id).sort()).toEqual(['mem_BETA', 'mem_BOTH']);
    });

    test('all matches only memories carrying every supplied project', async () => {
      const result = await searchMemories(
        {
          query: 'onboarding',
          scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B], match: 'all' },
        },
        opts(),
      );

      expect(result.results.map((r) => r.id)).toEqual(['mem_BOTH']);
    });
  });

  describe('archived memories', () => {
    beforeEach(() => {
      index.upsert(
        memoryRecord({
          id: 'mem_OLD',
          title: 'Webhook delivery used to lag',
          description: 'Retired: the vendor fixed delivery.',
          status: 'archived',
          archive_reason: 'The vendor fixed webhook delivery.',
        }),
        'webhook delivery lag',
      );
    });

    test('are excluded by default', async () => {
      const result = await searchMemories({ query: 'webhook delivery', scope: PROJECTS }, opts());
      expect(result.results.map((r) => r.id)).not.toContain('mem_OLD');
    });

    test('are returned when explicitly requested', async () => {
      const result = await searchMemories(
        { query: 'webhook delivery', scope: PROJECTS, status: ['active', 'archived'] },
        opts(),
      );
      expect(result.results.map((r) => r.id)).toContain('mem_OLD');
    });
  });

  describe('input validation', () => {
    test('rejects an empty query', async () => {
      await expect(searchMemories({ query: '', scope: PROJECTS }, opts())).rejects.toBeInstanceOf(
        MementoError,
      );
    });

    test('requires a scope', async () => {
      await expect(searchMemories({ query: 'webhook' }, opts())).rejects.toMatchObject({
        code: 'validation_error',
      });
    });

    test('rejects unknown input keys', async () => {
      await expect(
        searchMemories({ query: 'x', scope: PROJECTS, bogus: 1 }, opts()),
      ).rejects.toBeInstanceOf(MementoError);
    });
  });
});

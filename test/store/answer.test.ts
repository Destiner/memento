import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { answerMemory } from '../../src/store/answer.js';
import { serializeFrontmatter } from '../../src/store/frontmatter.js';
import { memoryFilename } from '../../src/store/id.js';
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

describe('answerMemory', () => {
  let dir: string;
  let index: MemoryIndex;

  // Write a canonical file (so the ## Summary section is on disk) and index it.
  const add = (meta: MemoryMetadata, body: string): void => {
    writeFileSync(join(dir, memoryFilename(meta.id, meta.title)), serializeFrontmatter(meta, body));
    index.upsert(meta, body);
  };

  const opts = () => ({ index, memoriesDir: dir, maxLimit: 10 });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-answer-'));
    index = new MemoryIndex();
  });

  afterEach(() => {
    index.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test('returns an answer, sources, confidence, and caveat', async () => {
    add(
      memory({
        id: 'mem_EMAIL',
        title: 'ExampleEmailVendor deliverability',
        type: 'integration',
        entities: ['ExampleEmailVendor'],
        confidence: 'high',
        importance: 'high',
      }),
      '## Summary\n\nWebhook delivery can be delayed at peak volume, so retry policies must not assume prompt delivery.\n\n## Context\n\nObserved during a launch.',
    );

    const result = await answerMemory({ question: 'email vendor webhook delivery delay' }, opts());

    expect(result.answer).toContain('Webhook delivery can be delayed');
    expect(result.sources).toEqual([
      {
        id: 'mem_EMAIL',
        title: 'ExampleEmailVendor deliverability',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ]);
    expect(['high', 'medium', 'low']).toContain(result.confidence);
    expect(result.caveat.length).toBeGreaterThan(0);
  });

  test('draws the answer from the ## Summary section, not other sections', async () => {
    add(
      memory({ id: 'mem_SUM', title: 'Caching strategy' }),
      '## Summary\n\nCache entitlement lookups for five minutes.\n\n## Guidance\n\nInvalidate on write via the explicit hook.',
    );

    const result = await answerMemory({ question: 'caching strategy entitlement' }, opts());
    expect(result.answer).toBe('Cache entitlement lookups for five minutes.');
    expect(result.answer).not.toContain('Invalidate on write');
  });

  test('falls back to the index excerpt when there is no Summary section', async () => {
    add(
      memory({ id: 'mem_NOSUM', title: 'Rate limiting' }),
      'The public API enforces a token bucket rate limit per API key.',
    );

    const result = await answerMemory({ question: 'public API rate limit token bucket' }, opts());
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.answer.toLowerCase()).toContain('rate limit');
  });

  test('omits sources when include_sources is false', async () => {
    add(memory({ id: 'mem_X', title: 'Widget' }), '## Summary\n\nWidgets are green.');

    const result = await answerMemory(
      { question: 'widget colour', include_sources: false },
      opts(),
    );
    expect(result.sources).toEqual([]);
    expect(result.answer).toContain('green');
  });

  test('a low-confidence top source caps the answer confidence at low', async () => {
    add(
      memory({
        id: 'mem_LOW',
        title: 'Rumoured migration timeline',
        confidence: 'low',
        importance: 'high',
      }),
      '## Summary\n\nThe migration is rumoured to finish next quarter, but this is unconfirmed.',
    );

    const result = await answerMemory({ question: 'rumoured migration timeline' }, opts());
    expect(result.confidence).toBe('low');
  });

  test('returns a low-confidence empty answer when nothing matches', async () => {
    add(memory({ id: 'mem_ONLY', title: 'Billing' }), '## Summary\n\nBilling runs monthly.');

    const result = await answerMemory({ question: 'kubernetes autoscaling policy' }, opts());
    expect(result.sources).toEqual([]);
    expect(result.confidence).toBe('low');
    expect(result.answer.length).toBeGreaterThan(0);
    expect(result.caveat.toLowerCase()).toContain('no relevant memory');
  });

  test('clamps the limit to the configured maximum', async () => {
    for (let i = 0; i < 8; i++) {
      add(
        memory({ id: `mem_B${i}`, title: `webhook note ${i}` }),
        `## Summary\n\nwebhook detail ${i}`,
      );
    }

    const result = await answerMemory(
      { question: 'webhook', limit: 50 },
      { index, memoriesDir: dir, maxLimit: 3 },
    );
    expect(result.sources.length).toBeLessThanOrEqual(3);
  });

  test('rejects an empty question', async () => {
    await expect(answerMemory({ question: '' }, opts())).rejects.toThrow(MementoError);
  });

  test('rejects unknown input keys', async () => {
    await expect(answerMemory({ question: 'x', bogus: 1 }, opts())).rejects.toThrow(MementoError);
  });
});

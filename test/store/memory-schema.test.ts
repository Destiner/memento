import { describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import {
  archiveMemoryInputSchema,
  createMemoryInputSchema,
  getMemoryInputSchema,
  memoryProjectIds,
  searchMemoriesInputSchema,
  toMemorySummary,
  updateMemoryInputSchema,
  validateMemoryFrontmatter,
} from '../../src/store/memory-schema.js';

const record = {
  id: 'mem_TEST0001',
  title: 'Webhook retries read as duplicate deliveries',
  description:
    'When the idempotency key derives from the payload hash, a vendor retry of a mutated payload creates a second record.',
  scope: { kind: 'projects', project_ids: ['prj_TEST0001'] },
  type: 'debugging_pattern',
  provenance: {
    source: 'agent_observed',
    verification: 'observed_once',
    evidence: [{ kind: 'commit', value: '9f2c1ab', note: 'introduced the payload-hash key' }],
  },
  status: 'active',
  created_at: '2026-07-31T21:14:03Z',
  updated_at: '2026-07-31T21:14:03Z',
};

const createInput = {
  title: record.title,
  description: record.description,
  scope: record.scope,
  type: record.type,
  body: 'The vendor retries with a mutated payload, so the hash differs and the guard misses.',
  provenance: { source: 'agent_observed' },
};

describe('validateMemoryFrontmatter', () => {
  test('accepts a single-project memory', () => {
    expect(validateMemoryFrontmatter(record)).toMatchObject({ id: 'mem_TEST0001' });
  });

  test('accepts a multi-project memory', () => {
    const multi = {
      ...record,
      scope: { kind: 'projects', project_ids: ['prj_TEST0001', 'prj_TEST0002'] },
    };
    expect(memoryProjectIds(validateMemoryFrontmatter(multi))).toEqual([
      'prj_TEST0001',
      'prj_TEST0002',
    ]);
  });

  test('accepts a global memory, which has no project ids', () => {
    const global = { ...record, scope: { kind: 'global' }, type: 'preference' };
    expect(memoryProjectIds(validateMemoryFrontmatter(global))).toEqual([]);
  });

  test('accepts an archived memory carrying a reason', () => {
    const archived = { ...record, status: 'archived', archive_reason: 'vendor fixed the retry' };
    expect(() => validateMemoryFrontmatter(archived)).not.toThrow();
  });

  test('accepts a re-verified memory', () => {
    const verified = { ...record, last_verified_at: '2026-08-04T09:02:11Z' };
    expect(() => validateMemoryFrontmatter(verified)).not.toThrow();
  });

  test.each([
    ['an unknown top-level key', { ...record, tags: ['webhooks'] }],
    ['an unknown provenance key', { ...record, provenance: { ...record.provenance, weight: 1 } }],
    ['an out-of-vocabulary type', { ...record, type: 'integration' }],
    ['an out-of-vocabulary status', { ...record, status: 'needs_review' }],
    ['an out-of-vocabulary source', { ...record, provenance: { source: 'guessed' } }],
    ['a missing verification', { ...record, provenance: { source: 'inferred' } }],
    ['a missing description', { ...record, description: undefined }],
    ['an over-long title', { ...record, title: 'a'.repeat(121) }],
    ['an over-long description', { ...record, description: 'a'.repeat(401) }],
    ['a date-only timestamp', { ...record, created_at: '2026-07-31' }],
    ['a memory id in the wrong namespace', { ...record, id: 'prj_TEST0001' }],
  ])('rejects %s', (_label, candidate) => {
    expect(() => validateMemoryFrontmatter(candidate)).toThrow(MementoError);
  });

  test.each([
    ['project ids on a global scope', { kind: 'global', project_ids: ['prj_TEST0001'] }],
    ['an empty project id list', { kind: 'projects', project_ids: [] }],
    ['a malformed project id', { kind: 'projects', project_ids: ['memento'] }],
    ['a project id with a path separator', { kind: 'projects', project_ids: ['prj_../escape'] }],
    ['more than ten project ids', { kind: 'projects', project_ids: elevenProjectIds() }],
    ['a bare scope string', 'projects'],
    ['a scope without a kind', { project_ids: ['prj_TEST0001'] }],
  ])('rejects %s', (_label, scope) => {
    expect(() => validateMemoryFrontmatter({ ...record, scope })).toThrow(MementoError);
  });

  test('rejects an archived memory with no reason', () => {
    expect(() => validateMemoryFrontmatter({ ...record, status: 'archived' })).toThrow(
      MementoError,
    );
  });

  test('rejects an archive reason on an active memory', () => {
    expect(() =>
      validateMemoryFrontmatter({ ...record, archive_reason: 'left over from a restore' }),
    ).toThrow(MementoError);
  });

  test.each([
    ['an unknown evidence kind', [{ kind: 'slack_thread', value: 'https://example.com/t/1' }]],
    ['an evidence entry without a value', [{ kind: 'commit' }]],
    ['an unknown evidence key', [{ kind: 'commit', value: '9f2c1ab', added_by: 'agent' }]],
    ['an over-long evidence note', [{ kind: 'commit', value: '9f2c1ab', note: 'a'.repeat(201) }]],
    ['more than ten evidence entries', elevenCommits()],
  ])('rejects %s', (_label, evidence) => {
    expect(() =>
      validateMemoryFrontmatter({ ...record, provenance: { ...record.provenance, evidence } }),
    ).toThrow(MementoError);
  });
});

describe('toMemorySummary', () => {
  test('carries the search-result fields and nothing heavier', () => {
    const summary = toMemorySummary(validateMemoryFrontmatter(record));
    expect(Object.keys(summary)).toEqual([
      'id',
      'title',
      'description',
      'scope',
      'type',
      'status',
      'updated_at',
    ]);
  });
});

describe('createMemoryInputSchema', () => {
  test('accepts the minimum: no verification, no evidence', () => {
    expect(createMemoryInputSchema.safeParse(createInput).success).toBe(true);
  });

  test('rejects server-managed fields', () => {
    for (const field of ['id', 'status', 'created_at', 'updated_at', 'archive_reason']) {
      const input = { ...createInput, [field]: 'anything' };
      expect(createMemoryInputSchema.safeParse(input).success).toBe(false);
    }
  });

  test('rejects a body over the length cap', () => {
    const input = { ...createInput, body: 'a'.repeat(12001) };
    expect(createMemoryInputSchema.safeParse(input).success).toBe(false);
  });

  test('requires a reason with force_create', () => {
    expect(createMemoryInputSchema.safeParse({ ...createInput, force_create: true }).success).toBe(
      false,
    );
    expect(
      createMemoryInputSchema.safeParse({
        ...createInput,
        force_create: true,
        force_create_reason: 'the vendor case differs from the internal one',
      }).success,
    ).toBe(true);
  });

  test('rejects a reason without force_create', () => {
    expect(
      createMemoryInputSchema.safeParse({ ...createInput, force_create_reason: 'because' }).success,
    ).toBe(false);
  });
});

describe('searchMemoriesInputSchema', () => {
  test('requires an explicit scope', () => {
    expect(searchMemoriesInputSchema.safeParse({ query: 'webhook retries' }).success).toBe(false);
  });

  test('defaults to any-project matching and active memories', () => {
    const parsed = searchMemoriesInputSchema.parse({
      query: 'webhook retries',
      scope: { kind: 'projects', project_ids: ['prj_TEST0001'] },
    });
    expect(parsed.scope).toEqual({
      kind: 'projects',
      project_ids: ['prj_TEST0001'],
      match: 'any',
    });
    expect(parsed.status).toEqual(['active']);
  });

  test('accepts all-project matching and an explicit archived request', () => {
    const parsed = searchMemoriesInputSchema.parse({
      query: 'onboarding',
      scope: { kind: 'projects', project_ids: ['prj_A', 'prj_B'], match: 'all' },
      status: ['active', 'archived'],
    });
    expect(parsed.scope).toMatchObject({ match: 'all' });
    expect(parsed.status).toEqual(['active', 'archived']);
  });

  test('accepts a global search', () => {
    expect(
      searchMemoriesInputSchema.safeParse({ query: 'commit style', scope: { kind: 'global' } })
        .success,
    ).toBe(true);
  });

  test.each([
    ['project ids on a global scope', { kind: 'global', project_ids: ['prj_A'] }],
    ['no project ids', { kind: 'projects', project_ids: [] }],
    ['a malformed project id', { kind: 'projects', project_ids: ['memento'] }],
    ['an unknown match mode', { kind: 'projects', project_ids: ['prj_A'], match: 'exact' }],
  ])('rejects %s', (_label, scope) => {
    expect(searchMemoriesInputSchema.safeParse({ query: 'x', scope }).success).toBe(false);
  });

  test('rejects an empty type filter', () => {
    expect(
      searchMemoriesInputSchema.safeParse({
        query: 'x',
        scope: { kind: 'global' },
        types: [],
      }).success,
    ).toBe(false);
  });
});

describe('updateMemoryInputSchema', () => {
  test.each([
    ['a metadata change', { changes: { title: 'A clearer title' } }],
    ['a full body replacement', { body: 'rewritten' }],
    ['a surgical body edit', { old_text: 'was', new_text: 'is' }],
    ['a re-verification on its own', { mark_verified: true }],
    ['a restore', { changes: { status: 'active' } }],
    ['a provenance patch', { changes: { provenance: { verification: 'user_confirmed' } } }],
  ])('accepts %s', (_label, patch) => {
    expect(updateMemoryInputSchema.safeParse({ id: 'mem_TEST0001', ...patch }).success).toBe(true);
  });

  test.each([
    ['nothing to change', {}],
    ['an empty changes object', { changes: {} }],
    ['an empty provenance patch', { changes: { provenance: {} } }],
    ['old_text without new_text', { old_text: 'was' }],
    ['a body and a surgical edit together', { body: 'x', old_text: 'was', new_text: 'is' }],
    ['archiving through update', { changes: { status: 'archived' } }],
    ['an archive reason through update', { changes: { archive_reason: 'stale' } }],
    ['editing created_at', { changes: { created_at: '2026-01-01T00:00:00Z' } }],
    [
      'stamping last_verified_at directly',
      { changes: { last_verified_at: '2026-01-01T00:00:00Z' } },
    ],
    ['replace with nothing to replace', { replace: true, changes: { title: 'x' } }],
    ['mark_verified: false alone', { mark_verified: false }],
  ])('rejects %s', (_label, patch) => {
    expect(updateMemoryInputSchema.safeParse({ id: 'mem_TEST0001', ...patch }).success).toBe(false);
  });

  test('accepts replace alongside an evidence patch', () => {
    expect(
      updateMemoryInputSchema.safeParse({
        id: 'mem_TEST0001',
        replace: true,
        changes: { provenance: { evidence: [{ kind: 'commit', value: '9f2c1ab' }] } },
      }).success,
    ).toBe(true);
  });

  test('accepts replace alongside a projects scope', () => {
    expect(
      updateMemoryInputSchema.safeParse({
        id: 'mem_TEST0001',
        replace: true,
        changes: { scope: { kind: 'projects', project_ids: ['prj_TEST0002'] } },
      }).success,
    ).toBe(true);
  });

  test('allows an empty new_text so a surgical edit can delete', () => {
    expect(
      updateMemoryInputSchema.safeParse({ id: 'mem_TEST0001', old_text: 'gone', new_text: '' })
        .success,
    ).toBe(true);
  });
});

describe('archiveMemoryInputSchema', () => {
  test('requires a reason (docs/memory-policy.md §10)', () => {
    expect(archiveMemoryInputSchema.safeParse({ id: 'mem_TEST0001' }).success).toBe(false);
    expect(archiveMemoryInputSchema.safeParse({ id: 'mem_TEST0001', reason: '   ' }).success).toBe(
      false,
    );
    expect(
      archiveMemoryInputSchema.safeParse({ id: 'mem_TEST0001', reason: 'vendor fixed the retry' })
        .success,
    ).toBe(true);
  });
});

describe('getMemoryInputSchema', () => {
  test('takes a memory id alone', () => {
    expect(getMemoryInputSchema.safeParse({ id: 'mem_TEST0001' }).success).toBe(true);
    expect(getMemoryInputSchema.safeParse({ id: 'prj_TEST0001' }).success).toBe(false);
    expect(getMemoryInputSchema.safeParse({ id: 'mem_TEST0001', body: true }).success).toBe(false);
  });
});

function elevenProjectIds(): string[] {
  return Array.from({ length: 11 }, (_unused, index) => `prj_TEST${index}`);
}

function elevenCommits(): { kind: string; value: string }[] {
  return Array.from({ length: 11 }, (_unused, index) => ({
    kind: 'commit',
    value: `9f2c1a${index}`,
  }));
}

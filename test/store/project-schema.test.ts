import { describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import {
  createProjectInputSchema,
  resolveProjectInputSchema,
  updateProjectInputSchema,
  validateProjectFrontmatter,
} from '../../src/store/project-schema.js';

const record = {
  id: 'prj_TEST0001',
  name: 'Memento',
  description: 'Local memory layer for coding agents.',
  aliases: ['Local Coding-Agent Memory'],
  identifiers: {
    git_remotes: ['github.com/destiner/memento'],
    repository_slugs: ['destiner/memento'],
  },
  working_directories: [
    { path: '/Users/destiner/code/memento', last_seen_at: '2026-07-31T09:15:00Z' },
  ],
  status: 'active',
  created_at: '2026-07-14T09:31:02Z',
  updated_at: '2026-07-31T09:15:00Z',
};

describe('validateProjectFrontmatter', () => {
  test('accepts a full record', () => {
    expect(validateProjectFrontmatter(record)).toMatchObject({ id: 'prj_TEST0001' });
  });

  test('accepts a record carrying only the required fields', () => {
    const minimal = {
      id: record.id,
      name: record.name,
      description: record.description,
      status: 'active',
      created_at: record.created_at,
      updated_at: record.updated_at,
    };
    expect(() => validateProjectFrontmatter(minimal)).not.toThrow();
  });

  test.each([
    ['an unknown top-level key', { ...record, owner: 'timur' }],
    ['an unknown identifier kind', { ...record, identifiers: { jira_keys: ['MEM'] } }],
    ['an out-of-vocabulary status', { ...record, status: 'deleted' }],
    ['a date-only timestamp', { ...record, created_at: '2026-07-14' }],
    [
      'a working directory without last_seen_at',
      { ...record, working_directories: [{ path: '/x' }] },
    ],
    ['an empty name', { ...record, name: '   ' }],
    ['an over-long name', { ...record, name: 'a'.repeat(81) }],
    ['an over-long description', { ...record, description: 'a'.repeat(281) }],
    ['a missing description', { ...record, description: undefined }],
  ])('rejects %s', (_label, candidate) => {
    expect(() => validateProjectFrontmatter(candidate)).toThrow(MementoError);
  });
});

describe('createProjectInputSchema', () => {
  test('rejects server-managed fields', () => {
    for (const field of ['id', 'status', 'created_at', 'updated_at']) {
      const input = { name: 'X', description: 'Y', [field]: 'anything' };
      expect(createProjectInputSchema.safeParse(input).success).toBe(false);
    }
  });

  test('takes working directories as bare strings', () => {
    const parsed = createProjectInputSchema.safeParse({
      name: 'X',
      description: 'Y',
      working_directories: ['/tmp/x'],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('updateProjectInputSchema', () => {
  test('requires at least one field to change', () => {
    expect(updateProjectInputSchema.safeParse({ id: 'prj_X' }).success).toBe(false);
    expect(updateProjectInputSchema.safeParse({ id: 'prj_X', name: 'Y' }).success).toBe(true);
  });

  test('rejects replace on its own', () => {
    expect(updateProjectInputSchema.safeParse({ id: 'prj_X', replace: true }).success).toBe(false);
  });

  test('rejects editing created_at', () => {
    expect(
      updateProjectInputSchema.safeParse({ id: 'prj_X', created_at: '2026-01-01T00:00:00Z' })
        .success,
    ).toBe(false);
  });
});

describe('resolveProjectInputSchema', () => {
  test('requires at least one piece of evidence', () => {
    expect(resolveProjectInputSchema.safeParse({}).success).toBe(false);
    expect(resolveProjectInputSchema.safeParse({ include_archived: true }).success).toBe(false);
    expect(resolveProjectInputSchema.safeParse({ name_hint: 'x' }).success).toBe(true);
  });
});

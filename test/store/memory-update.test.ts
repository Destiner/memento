import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { parseFrontmatter } from '../../src/store/frontmatter.js';
import { archiveMemory } from '../../src/store/memory-archive.js';
import { createMemory } from '../../src/store/memory-create.js';
import { updateMemory } from '../../src/store/memory-update.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { createInput, PROJECT_A, PROJECT_B, seedProjects } from '../helpers/memories.js';
import { createdMemory } from '../helpers/outcomes.js';

const T1 = Date.parse('2026-07-04T14:20:00Z');
const T2 = Date.parse('2026-08-01T09:00:00Z');

describe('updateMemory', () => {
  let home: string;
  let memoriesDir: string;
  let projectsDir: string;
  let index: MemoryIndex;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'memento-update-'));
    memoriesDir = join(home, 'memories');
    projectsDir = join(home, 'projects');
    index = new MemoryIndex();
    await seedProjects(projectsDir);
  });

  afterEach(() => {
    index.close();
    rmSync(home, { recursive: true, force: true });
  });

  function opts() {
    return { memoriesDir, projectsDir, index, now: T2 };
  }

  async function seed(overrides: Record<string, unknown> = {}, id = 'mem_UPD00001') {
    return createdMemory(
      await createMemory(createInput(overrides), {
        memoriesDir,
        projectsDir,
        index,
        now: T1,
        makeId: () => id,
      }),
    );
  }

  function frontmatter(path: string) {
    return parseFrontmatter(readFileSync(path, 'utf8'));
  }

  test('applies metadata changes, bumps updated_at, preserves created_at', async () => {
    const { path } = await seed();

    const result = await updateMemory(
      { id: 'mem_UPD00001', changes: { title: 'Retries duplicate sends', type: 'other' } },
      opts(),
    );

    expect(result.updated).toBe(true);
    expect(result.memory.title).toBe('Retries duplicate sends');
    expect(result.dropped_evidence).toEqual([]);
    const { metadata } = frontmatter(result.path);
    expect(metadata.type).toBe('other');
    expect(metadata.created_at).toBe('2026-07-04T14:20:00Z');
    expect(metadata.updated_at).toBe('2026-08-01T09:00:00Z');
    // The title changed, so the file moved.
    expect(result.path).not.toBe(path);
    expect(readdirSync(memoriesDir)).toEqual(['mem_UPD00001-retries-duplicate-sends.md']);
  });

  test('edits the body via an exact old_text/new_text match', async () => {
    const { path } = await seed();

    await updateMemory(
      { id: 'mem_UPD00001', old_text: 'idempotency keys', new_text: 'the idempotency key' },
      opts(),
    );

    expect(frontmatter(path).body).toBe(
      'Preserve the idempotency key; webhook arrival time is not a freshness signal.',
    );
  });

  test('replaces the whole body', async () => {
    const { path } = await seed();

    await updateMemory({ id: 'mem_UPD00001', body: 'Rewritten entirely.' }, opts());

    expect(frontmatter(path).body).toBe('Rewritten entirely.');
  });

  test('rejects old_text that is not found, leaving the file untouched', async () => {
    const { path } = await seed();
    const before = readFileSync(path, 'utf8');

    await expect(
      updateMemory({ id: 'mem_UPD00001', old_text: 'not present', new_text: 'x' }, opts()),
    ).rejects.toMatchObject({ code: 'invalid_request' });

    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  test('rejects old_text that matches more than once', async () => {
    await seed({ body: 'foo and foo again.' });

    await expect(
      updateMemory({ id: 'mem_UPD00001', old_text: 'foo', new_text: 'bar' }, opts()),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });

  describe('scope changes', () => {
    test('project ids merge-append by default', async () => {
      await seed();

      const result = await updateMemory(
        { id: 'mem_UPD00001', changes: { scope: { kind: 'projects', project_ids: [PROJECT_B] } } },
        opts(),
      );

      expect(result.memory.scope).toEqual({
        kind: 'projects',
        project_ids: [PROJECT_A, PROJECT_B],
      });
    });

    test('replace: true overwrites the project ids', async () => {
      await seed({ scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] } });

      const result = await updateMemory(
        {
          id: 'mem_UPD00001',
          changes: { scope: { kind: 'projects', project_ids: [PROJECT_B] } },
          replace: true,
        },
        opts(),
      );

      expect(result.memory.scope).toEqual({ kind: 'projects', project_ids: [PROJECT_B] });
    });

    test('switching to global discards the project ids', async () => {
      await seed();

      const result = await updateMemory(
        { id: 'mem_UPD00001', changes: { scope: { kind: 'global' } } },
        opts(),
      );

      expect(result.memory.scope).toEqual({ kind: 'global' });
    });

    test('rejects a project id no project answers to', async () => {
      await seed();

      await expect(
        updateMemory(
          {
            id: 'mem_UPD00001',
            changes: { scope: { kind: 'projects', project_ids: ['prj_NOPE'] } },
          },
          opts(),
        ),
      ).rejects.toMatchObject({ code: 'not_found', details: { unknown_ids: ['prj_NOPE'] } });
    });

    // A project deleted by hand must not block unrelated edits to its memories.
    test('does not re-check the ids already on the record', async () => {
      await seed();
      rmSync(projectsDir, { recursive: true, force: true });

      const result = await updateMemory(
        { id: 'mem_UPD00001', changes: { title: 'Still editable' } },
        opts(),
      );

      expect(result.memory.title).toBe('Still editable');
    });
  });

  describe('provenance', () => {
    test('patches source without silently re-deriving verification', async () => {
      await seed({ provenance: { source: 'user_stated' } });

      const result = await updateMemory(
        { id: 'mem_UPD00001', changes: { provenance: { source: 'inferred' } } },
        opts(),
      );

      expect(frontmatter(result.path).metadata.provenance).toEqual({
        source: 'inferred',
        verification: 'user_confirmed',
      });
    });

    test('appends evidence and reports what it dropped', async () => {
      await seed({
        provenance: {
          source: 'agent_observed',
          evidence: [{ kind: 'path', value: 'src/store/search-index.ts' }],
        },
      });

      const result = await updateMemory(
        {
          id: 'mem_UPD00001',
          changes: {
            provenance: {
              evidence: [
                { kind: 'commit', value: 'a1b2c3d4' },
                { kind: 'path', value: '/tmp/scratch.log' },
              ],
            },
          },
        },
        opts(),
      );

      expect(result.dropped_evidence).toEqual([
        {
          kind: 'path',
          value: '/tmp/scratch.log',
          why: 'an absolute path is machine-specific; use a repository-relative path',
        },
      ]);
      expect(frontmatter(result.path).metadata.provenance).toMatchObject({
        evidence: [
          { kind: 'path', value: 'src/store/search-index.ts' },
          { kind: 'commit', value: 'a1b2c3d4' },
        ],
      });
    });

    test('mark_verified stamps a server-side last_verified_at', async () => {
      await seed();

      const result = await updateMemory({ id: 'mem_UPD00001', mark_verified: true }, opts());

      expect(frontmatter(result.path).metadata.last_verified_at).toBe('2026-08-01T09:00:00Z');
    });
  });

  describe('status', () => {
    test('restoring an archived memory clears the archive reason', async () => {
      const seeded = await seed();
      await archiveMemory(
        { id: seeded.id, reason: 'The vendor fixed webhook delivery.' },
        { memoriesDir, index },
      );

      const result = await updateMemory({ id: seeded.id, changes: { status: 'active' } }, opts());

      expect(result.memory.status).toBe('active');
      const { metadata } = frontmatter(result.path);
      expect(metadata.status).toBe('active');
      expect(metadata).not.toHaveProperty('archive_reason');
    });

    test('an unrelated edit keeps an archived memory archived, reason intact', async () => {
      const seeded = await seed();
      await archiveMemory({ id: seeded.id, reason: 'No longer true.' }, { memoriesDir, index });

      const result = await updateMemory(
        { id: seeded.id, changes: { description: 'Kept for the record.' } },
        opts(),
      );

      const { metadata } = frontmatter(result.path);
      expect(metadata.status).toBe('archived');
      expect(metadata.archive_reason).toBe('No longer true.');
    });

    // Archiving always carries a reason (memory-policy.md §10), so it cannot come
    // in through the reason-free patch path.
    test('cannot archive through changes.status', async () => {
      await seed();

      await expect(
        updateMemory({ id: 'mem_UPD00001', changes: { status: 'archived' } }, opts()),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });
  });

  describe('input validation', () => {
    test('rejects body and old_text supplied together', async () => {
      await seed();
      await expect(
        updateMemory({ id: 'mem_UPD00001', body: 'x', old_text: 'y', new_text: 'z' }, opts()),
      ).rejects.toBeInstanceOf(MementoError);
    });

    test('rejects an update with no operation', async () => {
      await seed();
      await expect(updateMemory({ id: 'mem_UPD00001' }, opts())).rejects.toBeInstanceOf(
        MementoError,
      );
    });

    test('rejects changes to system fields', async () => {
      await seed();
      await expect(
        updateMemory(
          { id: 'mem_UPD00001', changes: { created_at: '2000-01-01T00:00:00Z' } },
          opts(),
        ),
      ).rejects.toBeInstanceOf(MementoError);
    });

    test('throws not_found for an unknown id', async () => {
      await expect(
        updateMemory({ id: 'mem_MISSING', changes: { title: 'x' } }, opts()),
      ).rejects.toMatchObject({ code: 'not_found' });
    });
  });
});

import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { parseFrontmatter } from '../../src/store/frontmatter.js';
import { archiveMemory } from '../../src/store/memory-archive.js';
import { createMemory } from '../../src/store/memory-create.js';
import { searchMemories } from '../../src/store/memory-search.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { createInput, PROJECT_A, seedProjects } from '../helpers/memories.js';
import { createdMemory } from '../helpers/outcomes.js';

const T1 = Date.parse('2026-07-04T14:20:00Z');
const T2 = Date.parse('2026-08-01T09:00:00Z');

describe('archiveMemory', () => {
  let home: string;
  let memoriesDir: string;
  let projectsDir: string;
  let index: MemoryIndex;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'memento-archive-'));
    memoriesDir = join(home, 'memories');
    projectsDir = join(home, 'projects');
    index = new MemoryIndex();
    await seedProjects(projectsDir, [PROJECT_A]);
  });

  afterEach(() => {
    index.close();
    rmSync(home, { recursive: true, force: true });
  });

  async function seed(id = 'mem_ARC00001') {
    return createdMemory(
      await createMemory(createInput(), {
        memoriesDir,
        projectsDir,
        index,
        now: T1,
        makeId: () => id,
      }),
    );
  }

  test('sets the status and reason, keeps the file, and bumps updated_at', async () => {
    const seeded = await seed();

    const result = await archiveMemory(
      { id: seeded.id, reason: 'The vendor fixed webhook delivery.' },
      { memoriesDir, index, now: T2 },
    );

    expect(result).toMatchObject({ id: seeded.id, path: seeded.path, archived: true });
    expect(result.memory.status).toBe('archived');
    expect(readdirSync(memoriesDir)).toHaveLength(1);

    const { metadata, body } = parseFrontmatter(readFileSync(seeded.path, 'utf8'));
    expect(metadata.status).toBe('archived');
    expect(metadata.archive_reason).toBe('The vendor fixed webhook delivery.');
    expect(metadata.created_at).toBe('2026-07-04T14:20:00Z');
    expect(metadata.updated_at).toBe('2026-08-01T09:00:00Z');
    expect(body).toContain('idempotency');
  });

  // Archived memories stay indexed: they drop out of the default search and come
  // back when a caller asks for them.
  test('drops the memory from the default search but keeps it retrievable', async () => {
    const seeded = await seed();
    const options = { index, projectsDir, defaultLimit: 5, maxLimit: 10 };
    const scope = { kind: 'projects', project_ids: [PROJECT_A] };

    await archiveMemory({ id: seeded.id, reason: 'No longer true.' }, { memoriesDir, index });

    const active = await searchMemories({ query: 'webhook retries', scope }, options);
    expect(active.result_count).toBe(0);

    const archived = await searchMemories(
      { query: 'webhook retries', scope, status: ['archived'] },
      options,
    );
    expect(archived.results.map((r) => r.id)).toEqual([seeded.id]);
  });

  // A state assertion, not a transition: the second call's reason is the
  // better-informed one.
  test('archiving twice replaces the reason instead of erroring', async () => {
    const seeded = await seed();

    await archiveMemory({ id: seeded.id, reason: 'First guess.' }, { memoriesDir, index });
    const result = await archiveMemory(
      { id: seeded.id, reason: 'Actually superseded by mem_OTHER.' },
      { memoriesDir, index },
    );

    expect(result.archived).toBe(true);
    const { metadata } = parseFrontmatter(readFileSync(seeded.path, 'utf8'));
    expect(metadata.archive_reason).toBe('Actually superseded by mem_OTHER.');
  });

  test('requires a reason', async () => {
    const seeded = await seed();

    await expect(archiveMemory({ id: seeded.id }, { memoriesDir, index })).rejects.toMatchObject({
      code: 'validation_error',
    });
    await expect(
      archiveMemory({ id: seeded.id, reason: '   ' }, { memoriesDir, index }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  test('throws not_found for an unknown id', async () => {
    await expect(
      archiveMemory({ id: 'mem_MISSING', reason: 'gone' }, { memoriesDir, index }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('rejects unknown input keys', async () => {
    const seeded = await seed();
    await expect(
      archiveMemory({ id: seeded.id, reason: 'x', hard_delete: true }, { memoriesDir, index }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });
});

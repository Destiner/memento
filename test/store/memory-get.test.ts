import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { createMemory } from '../../src/store/memory-create.js';
import { getMemory } from '../../src/store/memory-get.js';
import { MemoryIndex } from '../../src/store/search-index.js';
import { createInput, PROJECT_A, PROJECT_B, seedProjects } from '../helpers/memories.js';

describe('getMemory', () => {
  let home: string;
  let memoriesDir: string;
  let projectsDir: string;
  let index: MemoryIndex;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'memento-get-'));
    memoriesDir = join(home, 'memories');
    projectsDir = join(home, 'projects');
    index = new MemoryIndex();
    mkdirSync(memoriesDir, { recursive: true });
    await seedProjects(projectsDir);
  });

  afterEach(() => {
    index.close();
    rmSync(home, { recursive: true, force: true });
  });

  function seed(overrides: Record<string, unknown> = {}, id = 'mem_GET00001') {
    return createMemory(createInput(overrides), {
      memoriesDir,
      projectsDir,
      index,
      makeId: () => id,
    });
  }

  test('returns the full record, the body, and the project names', async () => {
    await seed({ scope: { kind: 'projects', project_ids: [PROJECT_A, PROJECT_B] } });

    const result = await getMemory({ id: 'mem_GET00001' }, { memoriesDir, projectsDir });

    expect(result.id).toBe('mem_GET00001');
    expect(result.title).toBe('Webhook retries duplicate sends under load');
    expect(result.type).toBe('debugging_pattern');
    expect(result.status).toBe('active');
    expect(result.provenance).toEqual({
      source: 'agent_observed',
      verification: 'observed_once',
    });
    expect(result.body).toBe(
      'Preserve idempotency keys; webhook arrival time is not a freshness signal.',
    );
    expect(result.projects).toEqual([
      { id: PROJECT_A, name: 'Alpha' },
      { id: PROJECT_B, name: 'Beta' },
    ]);
  });

  test('a global memory resolves to no project names', async () => {
    await seed({ scope: { kind: 'global' } }, 'mem_GETGLOBAL');

    const result = await getMemory({ id: 'mem_GETGLOBAL' }, { memoriesDir, projectsDir });

    expect(result.scope).toEqual({ kind: 'global' });
    expect(result.projects).toEqual([]);
  });

  // A hand-deleted project record costs the memory its label, not its readability.
  test('reports a dangling project id with a null name', async () => {
    await seed();
    rmSync(projectsDir, { recursive: true, force: true });

    const result = await getMemory({ id: 'mem_GET00001' }, { memoriesDir, projectsDir });

    expect(result.projects).toEqual([{ id: PROJECT_A, name: null }]);
  });

  test('throws not_found for an unknown id', async () => {
    await expect(
      getMemory({ id: 'mem_MISSING' }, { memoriesDir, projectsDir }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  test('rejects a corrupt on-disk record', async () => {
    writeFileSync(join(memoriesDir, 'mem_BROKEN-x.md'), '---\ntype: nonsense\n---\n\nbody\n');
    await expect(
      getMemory({ id: 'mem_BROKEN' }, { memoriesDir, projectsDir }),
    ).rejects.toBeInstanceOf(MementoError);
  });

  // V1 -> V2 storage migration is out of scope, so a V1 memory must fail loudly
  // rather than be half-read.
  test('rejects a V1 memory file', async () => {
    writeFileSync(
      join(memoriesDir, 'mem_V1OLD-x.md'),
      [
        '---',
        'id: mem_V1OLD',
        'title: Old shape',
        'type: integration',
        'scope: cross_project',
        'status: active',
        'created_at: 2026-01-01T00:00:00Z',
        'updated_at: 2026-01-01T00:00:00Z',
        'tags:',
        '  - legacy',
        '---',
        '',
        '## Summary',
        'V1 body.',
        '',
      ].join('\n'),
    );

    await expect(
      getMemory({ id: 'mem_V1OLD' }, { memoriesDir, projectsDir }),
    ).rejects.toMatchObject({ code: 'validation_error' });
  });

  test('rejects unknown input keys', async () => {
    await seed();
    await expect(
      getMemory({ id: 'mem_GET00001', version: 2 }, { memoriesDir, projectsDir }),
    ).rejects.toBeInstanceOf(MementoError);
  });
});

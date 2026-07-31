import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createProject } from '../../src/store/project-create.js';
import { loadProjectRegistry, requireProject } from '../../src/store/project-registry.js';

describe('loadProjectRegistry', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-projects-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('treats a missing registry directory as empty', async () => {
    const registry = await loadProjectRegistry(join(dir, 'absent'));
    expect(registry.all).toEqual([]);
    expect(registry.active).toEqual([]);
  });

  test('separates active from archived records', async () => {
    await createProject(
      { name: 'Live', description: 'Active project.' },
      { projectsDir: dir, makeId: () => 'prj_LIVE' },
    );
    const gone = await createProject(
      { name: 'Gone', description: 'Archived project.' },
      { projectsDir: dir, makeId: () => 'prj_GONE' },
    );
    writeFileSync(gone.path, readFileSync(gone.path, 'utf8').replace('active', 'archived'));

    const registry = await loadProjectRegistry(dir);

    expect(registry.all).toHaveLength(2);
    expect(registry.active.map((entry) => entry.record.id)).toEqual(['prj_LIVE']);
  });

  test('reads a record back from a hand-renamed file', async () => {
    const created = await createProject(
      { name: 'Memento', description: 'Local memory layer.' },
      { projectsDir: dir, makeId: () => 'prj_MEM' },
    );
    const renamed = join(dir, 'my-notes-about-memento.md');
    writeFileSync(renamed, readFileSync(created.path, 'utf8'));
    rmSync(created.path);

    const registry = await loadProjectRegistry(dir);
    expect(registry.byId('prj_MEM')?.record.name).toBe('Memento');
  });

  test('ignores non-markdown files', async () => {
    writeFileSync(join(dir, 'README.txt'), 'not a project');
    await expect(loadProjectRegistry(dir)).resolves.toMatchObject({ all: [] });
  });

  // A silently dropped project is the worst outcome: resolution reports
  // not_found, the agent creates a duplicate, and memories split across two ids.
  test('fails loudly on an unreadable record rather than skipping it', async () => {
    writeFileSync(join(dir, 'prj_BROKEN-x.md'), '---\nid: prj_BROKEN\nname: Broken\n---\n');

    await expect(loadProjectRegistry(dir)).rejects.toMatchObject({ code: 'internal_error' });
  });

  test('fails loudly when a file has no front matter at all', async () => {
    writeFileSync(join(dir, 'prj_JUNK-x.md'), 'just some markdown\n');
    await expect(loadProjectRegistry(dir)).rejects.toMatchObject({ code: 'internal_error' });
  });

  test('rejects two files claiming one id', async () => {
    const created = await createProject(
      { name: 'Memento', description: 'Local memory layer.' },
      { projectsDir: dir, makeId: () => 'prj_MEM' },
    );
    writeFileSync(join(dir, 'prj_MEM-copy.md'), readFileSync(created.path, 'utf8'));

    await expect(loadProjectRegistry(dir)).rejects.toMatchObject({ code: 'internal_error' });
  });

  test('picks up an edit made directly to a file on disk', async () => {
    const created = await createProject(
      { name: 'Memento', description: 'Local memory layer.' },
      { projectsDir: dir, makeId: () => 'prj_MEM' },
    );
    await loadProjectRegistry(dir);

    writeFileSync(
      created.path,
      readFileSync(created.path, 'utf8').replace('Local memory layer.', 'Edited by hand.'),
    );

    const registry = await loadProjectRegistry(dir);
    expect(registry.byId('prj_MEM')?.record.description).toBe('Edited by hand.');
  });
});

describe('requireProject', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-projects-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('throws not_found for an unknown id', async () => {
    const registry = await loadProjectRegistry(dir);
    expect(() => requireProject(registry, 'prj_MISSING')).toThrowError(/No project found/);
  });

  test('rejects an id that could reach outside the registry', async () => {
    const registry = await loadProjectRegistry(dir);
    expect(() => requireProject(registry, '../../etc/passwd')).toThrowError(/Invalid project id/);
  });
});

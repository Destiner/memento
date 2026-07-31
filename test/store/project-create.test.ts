import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { parseFrontmatter } from '../../src/store/frontmatter.js';
import { createProject } from '../../src/store/project-create.js';
import { validateProjectFrontmatter } from '../../src/store/project-schema.js';
import { updateProject } from '../../src/store/project-update.js';

const FIXED_NOW = Date.parse('2026-07-31T09:15:00Z');

const minimal = { name: 'Memento', description: 'Local memory layer for coding agents.' };

describe('createProject', () => {
  let dir: string;
  let workspace: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-projects-'));
    workspace = realpathSync(mkdtempSync(join(tmpdir(), 'memento-workspace-')));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  });

  test('writes a canonical registry file and returns its identity', async () => {
    const result = await createProject(minimal, {
      projectsDir: dir,
      now: FIXED_NOW,
      makeId: () => 'prj_TEST0001',
    });

    expect(result.id).toBe('prj_TEST0001');
    expect(result.created).toBe(true);
    expect(result.path).toBe(join(dir, 'prj_TEST0001-memento.md'));
    expect(readdirSync(dir)).toEqual(['prj_TEST0001-memento.md']);
  });

  test('sets server-managed lifecycle fields and omits empty optionals', async () => {
    const result = await createProject(minimal, {
      projectsDir: dir,
      now: FIXED_NOW,
      makeId: () => 'prj_TEST0002',
    });
    const { metadata, body } = parseFrontmatter(readFileSync(result.path, 'utf8'));

    expect(metadata.id).toBe('prj_TEST0002');
    expect(metadata.status).toBe('active');
    expect(metadata.created_at).toBe('2026-07-31T09:15:00Z');
    expect(metadata.updated_at).toBe('2026-07-31T09:15:00Z');
    expect(metadata).not.toHaveProperty('aliases');
    expect(metadata).not.toHaveProperty('identifiers');
    expect(metadata).not.toHaveProperty('working_directories');
    expect(body).toBe('');
  });

  // Item 10: a local project with no git remote is a first-class case.
  test('registers a project with only a working directory', async () => {
    const checkout = join(workspace, 'sandbox');
    mkdirSync(checkout);

    const result = await createProject(
      { ...minimal, working_directories: [checkout] },
      { projectsDir: dir, now: FIXED_NOW, makeId: () => 'prj_TEST0003' },
    );

    expect(result.record.working_directories).toEqual([
      { path: checkout, last_seen_at: '2026-07-31T09:15:00Z' },
    ]);
    expect(result.record.identifiers).toBeUndefined();
  });

  test('canonicalizes remotes and derives repository slugs', async () => {
    const result = await createProject(
      {
        ...minimal,
        identifiers: { git_remotes: ['git@GitHub.com:Destiner/Memento.git'] },
      },
      { projectsDir: dir, makeId: () => 'prj_TEST0004' },
    );

    expect(result.record.identifiers).toEqual({
      git_remotes: ['github.com/destiner/memento'],
      repository_slugs: ['destiner/memento'],
    });
  });

  test('unions explicit slugs with derived ones and deduplicates', async () => {
    const result = await createProject(
      {
        ...minimal,
        identifiers: {
          git_remotes: ['https://github.com/destiner/memento.git'],
          repository_slugs: ['Destiner/Memento', 'destiner/legacy-memento'],
        },
      },
      { projectsDir: dir, makeId: () => 'prj_TEST0005' },
    );

    expect(result.record.identifiers?.repository_slugs).toEqual([
      'destiner/memento',
      'destiner/legacy-memento',
    ]);
  });

  test('drops an alias that merely restates the name', async () => {
    const result = await createProject(
      { ...minimal, aliases: ['memento', 'Local Coding-Agent Memory'] },
      { projectsDir: dir, makeId: () => 'prj_TEST0006' },
    );

    expect(result.record.aliases).toEqual(['Local Coding-Agent Memory']);
  });

  test('produces a record that re-validates against the schema', async () => {
    const result = await createProject(
      { ...minimal, working_directories: [workspace], aliases: ['mem'] },
      { projectsDir: dir, makeId: () => 'prj_TEST0007' },
    );
    const { metadata } = parseFrontmatter(readFileSync(result.path, 'utf8'));
    expect(() => validateProjectFrontmatter(metadata)).not.toThrow();
  });

  describe('uniqueness', () => {
    test('rejects a name already held by an active project', async () => {
      await createProject(minimal, { projectsDir: dir, makeId: () => 'prj_FIRST' });

      await expect(
        createProject({ ...minimal, name: '  memento!  ' }, { projectsDir: dir }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
      expect(readdirSync(dir)).toHaveLength(1);
    });

    test('rejects a name held as another project alias', async () => {
      await createProject(
        { ...minimal, aliases: ['Recall'] },
        { projectsDir: dir, makeId: () => 'prj_FIRST' },
      );

      await expect(
        createProject({ name: 'recall', description: 'Something else.' }, { projectsDir: dir }),
      ).rejects.toMatchObject({ code: 'invalid_request' });
    });

    test('rejects a working directory already claimed, naming the owner', async () => {
      await createProject(
        { ...minimal, working_directories: [workspace] },
        { projectsDir: dir, makeId: () => 'prj_OWNER' },
      );

      await expect(
        createProject(
          { name: 'Other', description: 'Different project.', working_directories: [workspace] },
          { projectsDir: dir },
        ),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { conflict: 'working_directory', project_id: 'prj_OWNER' },
      });
    });

    // S1: a monorepo hosts several projects behind one remote, so a shared
    // remote must not be a conflict.
    test('allows two projects to share a git remote', async () => {
      const remotes = { git_remotes: ['github.com/acme/mono'] };
      await createProject(
        { name: 'API', description: 'The api package.', identifiers: remotes },
        { projectsDir: dir, makeId: () => 'prj_API' },
      );
      const second = await createProject(
        { name: 'Web', description: 'The web package.', identifiers: remotes },
        { projectsDir: dir, makeId: () => 'prj_WEB' },
      );

      expect(second.created).toBe(true);
      expect(readdirSync(dir)).toHaveLength(2);
    });

    test('ignores archived projects when checking uniqueness', async () => {
      await createProject(minimal, { projectsDir: dir, makeId: () => 'prj_OLD' });
      await updateProject({ id: 'prj_OLD', status: 'archived' }, { projectsDir: dir });

      const revived = await createProject(minimal, { projectsDir: dir, makeId: () => 'prj_NEW' });
      expect(revived.created).toBe(true);
    });
  });

  describe('input validation', () => {
    test('rejects a missing description', async () => {
      await expect(createProject({ name: 'Memento' }, { projectsDir: dir })).rejects.toBeInstanceOf(
        MementoError,
      );
      expect(readdirSync(dir)).toEqual([]);
    });

    test('rejects server-managed fields', async () => {
      await expect(
        createProject({ ...minimal, id: 'prj_HAND' }, { projectsDir: dir }),
      ).rejects.toBeInstanceOf(MementoError);
      await expect(
        createProject({ ...minimal, status: 'archived' }, { projectsDir: dir }),
      ).rejects.toBeInstanceOf(MementoError);
    });

    test('rejects a relative working directory without writing a file', async () => {
      await expect(
        createProject({ ...minimal, working_directories: ['./relative'] }, { projectsDir: dir }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      expect(readdirSync(dir)).toEqual([]);
    });

    test('rejects an unparseable git remote', async () => {
      await expect(
        createProject(
          { ...minimal, identifiers: { git_remotes: ['not a remote'] } },
          { projectsDir: dir },
        ),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });
  });
});

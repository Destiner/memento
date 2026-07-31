import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { parseFrontmatter, serializeFrontmatter } from '../../src/store/frontmatter.js';
import { MAX_WORKING_DIRECTORIES } from '../../src/store/project-normalize.js';
import { createProject } from '../../src/store/project-create.js';
import { updateProject } from '../../src/store/project-update.js';

const CREATED_AT = Date.parse('2026-07-01T08:00:00Z');
const UPDATED_AT = Date.parse('2026-07-31T09:15:00Z');

describe('updateProject', () => {
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

  async function seed(input: Record<string, unknown> = {}) {
    return createProject(
      { name: 'Memento', description: 'Local memory layer.', ...input },
      { projectsDir: dir, now: CREATED_AT, makeId: () => 'prj_SEED' },
    );
  }

  test('patches one field and leaves the rest alone', async () => {
    await seed({ aliases: ['mem'], identifiers: { git_remotes: ['github.com/destiner/memento'] } });

    const result = await updateProject(
      { id: 'prj_SEED', description: 'Local, file-owned memory layer.' },
      { projectsDir: dir, now: UPDATED_AT },
    );

    expect(result.record.description).toBe('Local, file-owned memory layer.');
    expect(result.record.name).toBe('Memento');
    expect(result.record.aliases).toEqual(['mem']);
    expect(result.record.identifiers?.git_remotes).toEqual(['github.com/destiner/memento']);
    expect(result.record.created_at).toBe('2026-07-01T08:00:00Z');
    expect(result.record.updated_at).toBe('2026-07-31T09:15:00Z');
  });

  // P1: a local project that later gains a remote keeps its id.
  test('adding a git remote to a directory-only project preserves the id', async () => {
    const checkout = join(workspace, 'app');
    mkdirSync(checkout);
    const created = await seed({ working_directories: [checkout] });
    expect(created.record.identifiers).toBeUndefined();

    const result = await updateProject(
      { id: 'prj_SEED', identifiers: { git_remotes: ['git@github.com:destiner/memento.git'] } },
      { projectsDir: dir, now: UPDATED_AT },
    );

    expect(result.id).toBe('prj_SEED');
    expect(result.record.identifiers).toEqual({
      git_remotes: ['github.com/destiner/memento'],
      repository_slugs: ['destiner/memento'],
    });
    expect(result.record.working_directories?.map((entry) => entry.path)).toEqual([checkout]);
  });

  // P2: a moved checkout appends rather than replacing — the old entry may be a
  // worktree or another machine.
  test('a moved checkout appends a directory, most-recently-seen first', async () => {
    const before = join(workspace, 'old');
    const after = join(workspace, 'new');
    mkdirSync(before);
    mkdirSync(after);
    await seed({ working_directories: [before] });

    const result = await updateProject(
      { id: 'prj_SEED', working_directories: [after] },
      { projectsDir: dir, now: UPDATED_AT },
    );

    expect(result.record.working_directories).toEqual([
      { path: after, last_seen_at: '2026-07-31T09:15:00Z' },
      { path: before, last_seen_at: '2026-07-01T08:00:00Z' },
    ]);
  });

  test('re-reporting a known directory refreshes it instead of duplicating it', async () => {
    const checkout = join(workspace, 'app');
    mkdirSync(checkout);
    await seed({ working_directories: [checkout] });

    const result = await updateProject(
      { id: 'prj_SEED', working_directories: [`${checkout}/`] },
      { projectsDir: dir, now: UPDATED_AT },
    );

    expect(result.record.working_directories).toEqual([
      { path: checkout, last_seen_at: '2026-07-31T09:15:00Z' },
    ]);
  });

  test('evicts the least-recently-seen directory past the cap', async () => {
    await seed();
    for (let i = 0; i <= MAX_WORKING_DIRECTORIES; i++) {
      await updateProject(
        { id: 'prj_SEED', working_directories: [join(workspace, `checkout-${i}`)] },
        { projectsDir: dir, now: CREATED_AT + i * 1000 },
      );
    }

    const result = await updateProject(
      { id: 'prj_SEED', description: 'Unchanged otherwise.' },
      { projectsDir: dir, now: UPDATED_AT },
    );
    const paths = result.record.working_directories?.map((entry) => entry.path) ?? [];

    expect(paths).toHaveLength(MAX_WORKING_DIRECTORIES);
    expect(paths[0]).toBe(join(workspace, `checkout-${MAX_WORKING_DIRECTORIES}`));
    expect(paths).not.toContain(join(workspace, 'checkout-0'));
  });

  // P3: a rename preserves the old name as an alias, so resolution by the old
  // name keeps working without the agent having to think about it.
  test('a rename preserves the old name as an alias and moves the file', async () => {
    const created = await seed();

    const result = await updateProject(
      { id: 'prj_SEED', name: 'Recall' },
      { projectsDir: dir, now: UPDATED_AT },
    );

    expect(result.record.name).toBe('Recall');
    expect(result.record.aliases).toEqual(['Memento']);
    expect(result.path).toBe(join(dir, 'prj_SEED-recall.md'));
    expect(readdirSync(dir)).toEqual(['prj_SEED-recall.md']);
    expect(result.path).not.toBe(created.path);
  });

  test('a rename that only changes capitalization adds no alias', async () => {
    await seed();
    const result = await updateProject({ id: 'prj_SEED', name: 'memento' }, { projectsDir: dir });

    expect(result.record.name).toBe('memento');
    expect(result.record.aliases).toBeUndefined();
  });

  test('preserves the old name even when aliases are replaced wholesale', async () => {
    await seed({ aliases: ['mem'] });

    const result = await updateProject(
      { id: 'prj_SEED', name: 'Recall', aliases: ['rc'], replace: true },
      { projectsDir: dir },
    );

    expect(result.record.aliases).toEqual(['rc', 'Memento']);
  });

  test('preserves the human notes body across an update', async () => {
    const created = await seed();
    const raw = readFileSync(created.path, 'utf8');
    const { metadata } = parseFrontmatter(raw);
    writeFileSync(created.path, serializeFrontmatter(metadata, 'Owner notes: staging is flaky.'));

    const result = await updateProject(
      { id: 'prj_SEED', description: 'Edited.' },
      { projectsDir: dir },
    );
    const { body } = parseFrontmatter(readFileSync(result.path, 'utf8'));

    expect(body).toBe('Owner notes: staging is flaky.');
  });

  describe('merge versus replace', () => {
    test('appends to arrays by default', async () => {
      await seed({ identifiers: { git_remotes: ['github.com/acme/one'] } });

      const result = await updateProject(
        { id: 'prj_SEED', identifiers: { git_remotes: ['github.com/acme/two'] } },
        { projectsDir: dir },
      );

      expect(result.record.identifiers?.git_remotes).toEqual([
        'github.com/acme/one',
        'github.com/acme/two',
      ]);
    });

    test('replace swaps the identifiers object wholesale, dropping stale slugs', async () => {
      await seed({ identifiers: { git_remotes: ['github.com/acme/one'] } });

      const result = await updateProject(
        { id: 'prj_SEED', identifiers: { git_remotes: ['github.com/acme/two'] }, replace: true },
        { projectsDir: dir },
      );

      expect(result.record.identifiers).toEqual({
        git_remotes: ['github.com/acme/two'],
        repository_slugs: ['acme/two'],
      });
    });

    test('replace leaves fields the patch did not mention untouched', async () => {
      const checkout = join(workspace, 'app');
      mkdirSync(checkout);
      await seed({
        working_directories: [checkout],
        identifiers: { git_remotes: ['github.com/acme/one'] },
      });

      const result = await updateProject(
        { id: 'prj_SEED', identifiers: { git_remotes: ['github.com/acme/two'] }, replace: true },
        { projectsDir: dir },
      );

      expect(result.record.working_directories?.map((entry) => entry.path)).toEqual([checkout]);
    });
  });

  describe('status', () => {
    test('archives and restores through the same operation', async () => {
      await seed();

      const archived = await updateProject(
        { id: 'prj_SEED', status: 'archived' },
        { projectsDir: dir },
      );
      expect(archived.record.status).toBe('archived');

      const restored = await updateProject(
        { id: 'prj_SEED', status: 'active' },
        { projectsDir: dir },
      );
      expect(restored.record.status).toBe('active');
    });

    test('refuses to restore a project whose name was taken while archived', async () => {
      await seed();
      await updateProject({ id: 'prj_SEED', status: 'archived' }, { projectsDir: dir });
      await createProject(
        { name: 'Memento', description: 'The replacement.' },
        { projectsDir: dir, makeId: () => 'prj_NEW' },
      );

      await expect(
        updateProject({ id: 'prj_SEED', status: 'active' }, { projectsDir: dir }),
      ).rejects.toMatchObject({ code: 'invalid_request', details: { conflict: 'name' } });
    });
  });

  describe('rejections', () => {
    test('rejects an unknown project id', async () => {
      await expect(
        updateProject({ id: 'prj_MISSING', description: 'x' }, { projectsDir: dir }),
      ).rejects.toMatchObject({ code: 'not_found' });
    });

    test('rejects a malformed project id', async () => {
      await expect(
        updateProject({ id: '../escape', description: 'x' }, { projectsDir: dir }),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });

    test('rejects a patch that changes nothing', async () => {
      await seed();
      await expect(updateProject({ id: 'prj_SEED' }, { projectsDir: dir })).rejects.toBeInstanceOf(
        MementoError,
      );
    });

    test('rejects renaming onto another active project', async () => {
      await seed();
      await createProject(
        { name: 'Recall', description: 'Another project.' },
        { projectsDir: dir, makeId: () => 'prj_OTHER' },
      );

      await expect(
        updateProject({ id: 'prj_SEED', name: 'recall' }, { projectsDir: dir }),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { conflict: 'name', project_id: 'prj_OTHER' },
      });
    });

    test('rejects claiming a directory another active project holds', async () => {
      const checkout = join(workspace, 'shared');
      mkdirSync(checkout);
      await seed();
      await createProject(
        { name: 'Other', description: 'Owns the checkout.', working_directories: [checkout] },
        { projectsDir: dir, makeId: () => 'prj_OTHER' },
      );

      await expect(
        updateProject({ id: 'prj_SEED', working_directories: [checkout] }, { projectsDir: dir }),
      ).rejects.toMatchObject({
        code: 'invalid_request',
        details: { conflict: 'working_directory', project_id: 'prj_OTHER' },
      });
    });

    test('leaves the file unchanged when an update is rejected', async () => {
      const created = await seed();
      const before = readFileSync(created.path, 'utf8');

      await expect(
        updateProject(
          { id: 'prj_SEED', identifiers: { git_remotes: ['nonsense'] } },
          { projectsDir: dir },
        ),
      ).rejects.toBeInstanceOf(MementoError);

      expect(readFileSync(created.path, 'utf8')).toBe(before);
    });
  });
});

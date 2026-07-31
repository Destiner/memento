import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import { createProject } from '../../src/store/project-create.js';
import { resolveProject } from '../../src/store/project-resolve.js';
import { updateProject } from '../../src/store/project-update.js';

describe('resolveProject', () => {
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

  function checkout(...segments: string[]): string {
    const path = join(workspace, ...segments);
    mkdirSync(path, { recursive: true });
    return path;
  }

  async function project(
    id: string,
    input: Record<string, unknown> & { name: string },
  ): Promise<void> {
    await createProject(
      { description: `Project ${input.name}.`, ...input },
      {
        projectsDir: dir,
        makeId: () => id,
      },
    );
  }

  test('returns not_found against an empty registry', async () => {
    const result = await resolveProject({ name_hint: 'Memento' }, { projectsDir: dir });
    expect(result).toEqual({ outcome: 'not_found' });
  });

  test('matches an exact working directory', async () => {
    const path = checkout('memento');
    await project('prj_MEM', { name: 'Memento', working_directories: [path] });

    const result = await resolveProject({ working_directory: path }, { projectsDir: dir });

    expect(result).toMatchObject({
      outcome: 'exact_match',
      matched_on: 'working_directory',
      project: { id: 'prj_MEM', name: 'Memento' },
      suggestions: [],
    });
  });

  test('matches a subdirectory of a registered checkout', async () => {
    const root = checkout('memento');
    await project('prj_MEM', { name: 'Memento', working_directories: [root] });

    const result = await resolveProject(
      { working_directory: join(root, 'src', 'store') },
      { projectsDir: dir },
    );

    expect(result).toMatchObject({
      outcome: 'exact_match',
      matched_on: 'working_directory_prefix',
      project: { id: 'prj_MEM' },
    });
  });

  // The monorepo case: the deepest registered checkout wins, so a sub-project is
  // reachable even though its parent is registered too.
  test('prefers the deepest registered checkout', async () => {
    const root = checkout('mono');
    const api = checkout('mono', 'packages', 'api');
    await project('prj_MONO', { name: 'Mono', working_directories: [root] });
    await project('prj_API', { name: 'API', working_directories: [api] });

    const result = await resolveProject(
      { working_directory: join(api, 'src') },
      { projectsDir: dir },
    );

    expect(result).toMatchObject({ outcome: 'exact_match', project: { id: 'prj_API' } });
  });

  test('matches a canonical git remote regardless of the URL form supplied', async () => {
    await project('prj_MEM', {
      name: 'Memento',
      identifiers: { git_remotes: ['https://github.com/destiner/memento.git'] },
    });

    const result = await resolveProject(
      { git_remote: 'git@github.com:Destiner/Memento.git' },
      { projectsDir: dir },
    );

    expect(result).toMatchObject({ outcome: 'exact_match', matched_on: 'git_remote' });
  });

  // Item 10 / S1: a shared remote is ambiguous by design, not corrupt.
  test('returns candidates when several projects share a remote', async () => {
    const remotes = { git_remotes: ['github.com/acme/mono'] };
    await project('prj_API', { name: 'API', identifiers: remotes });
    await project('prj_WEB', { name: 'Web', identifiers: remotes });

    const result = await resolveProject(
      { git_remote: 'github.com/acme/mono' },
      { projectsDir: dir },
    );

    expect(result.outcome).toBe('candidates');
    if (result.outcome !== 'candidates') return;
    expect(result.matched_on).toBe('git_remote');
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(['prj_API', 'prj_WEB']);
  });

  test('a slug match never claims to be exact', async () => {
    await project('prj_MEM', {
      name: 'Memento',
      identifiers: { repository_slugs: ['destiner/memento'] },
    });

    const result = await resolveProject(
      { repository_slug: 'Destiner/Memento' },
      { projectsDir: dir },
    );

    expect(result).toMatchObject({ outcome: 'candidates', matched_on: 'repository_slug' });
  });

  test('matches an exact name and an alias equally', async () => {
    await project('prj_MEM', { name: 'Recall', aliases: ['Memento'] });

    await expect(
      resolveProject({ name_hint: 'recall' }, { projectsDir: dir }),
    ).resolves.toMatchObject({
      outcome: 'exact_match',
      matched_on: 'name',
      project: { id: 'prj_MEM' },
    });
    await expect(
      resolveProject({ name_hint: 'memento!' }, { projectsDir: dir }),
    ).resolves.toMatchObject({ outcome: 'exact_match', matched_on: 'name' });
  });

  test('falls back to fuzzy name candidates', async () => {
    await project('prj_API', { name: 'Billing API' });
    await project('prj_WEB', { name: 'Billing Web' });

    const result = await resolveProject({ name_hint: 'billing' }, { projectsDir: dir });

    expect(result).toMatchObject({ outcome: 'candidates', matched_on: 'name_fuzzy' });
    if (result.outcome !== 'candidates') return;
    expect(result.candidates.map((candidate) => candidate.name)).toEqual([
      'Billing API',
      'Billing Web',
    ]);
  });

  test('a punctuation-only hint matches nothing rather than everything', async () => {
    await project('prj_MEM', { name: 'Memento' });
    await expect(resolveProject({ name_hint: '!!!' }, { projectsDir: dir })).resolves.toEqual({
      outcome: 'not_found',
    });
  });

  describe('precedence', () => {
    test('a directory match beats a conflicting name hint', async () => {
      const path = checkout('memento');
      await project('prj_MEM', { name: 'Memento', working_directories: [path] });
      await project('prj_OTHER', { name: 'Other' });

      const result = await resolveProject(
        { working_directory: path, name_hint: 'Other' },
        { projectsDir: dir },
      );

      expect(result).toMatchObject({ outcome: 'exact_match', project: { id: 'prj_MEM' } });
    });

    test('an exact directory beats a deeper-registered prefix', async () => {
      const root = checkout('mono');
      await project('prj_MONO', { name: 'Mono', working_directories: [root] });

      const result = await resolveProject({ working_directory: root }, { projectsDir: dir });
      expect(result).toMatchObject({ matched_on: 'working_directory' });
    });
  });

  describe('suggestions', () => {
    test('reports evidence the matched project does not yet hold', async () => {
      await project('prj_MEM', { name: 'Memento' });
      const path = checkout('memento');

      const result = await resolveProject(
        {
          name_hint: 'Memento',
          working_directory: path,
          git_remote: 'git@github.com:destiner/memento.git',
        },
        { projectsDir: dir },
      );

      expect(result).toMatchObject({ outcome: 'exact_match', matched_on: 'name' });
      if (result.outcome !== 'exact_match') return;
      // No slug suggestion: update_project derives slugs from remotes, so
      // suggesting one alongside its remote would be redundant.
      expect(result.suggestions).toEqual([
        { field: 'working_directories', value: path },
        { field: 'git_remotes', value: 'github.com/destiner/memento' },
      ]);
    });

    test('suggests a slug supplied without a remote', async () => {
      await project('prj_MEM', { name: 'Memento' });

      const result = await resolveProject(
        { name_hint: 'Memento', repository_slug: 'destiner/memento' },
        { projectsDir: dir },
      );

      expect(result).toMatchObject({
        outcome: 'exact_match',
        suggestions: [{ field: 'repository_slugs', value: 'destiner/memento' }],
      });
    });

    test('suggests nothing when the record already holds the evidence', async () => {
      const path = checkout('memento');
      await project('prj_MEM', {
        name: 'Memento',
        working_directories: [path],
        identifiers: { git_remotes: ['github.com/destiner/memento'] },
      });

      const result = await resolveProject(
        { working_directory: path, git_remote: 'github.com/destiner/memento' },
        { projectsDir: dir },
      );

      expect(result).toMatchObject({ outcome: 'exact_match', suggestions: [] });
    });

    test('resolution writes nothing', async () => {
      const path = checkout('memento');
      await project('prj_MEM', { name: 'Memento' });
      const before = readRegistry(dir);

      await resolveProject({ name_hint: 'Memento', working_directory: path }, { projectsDir: dir });

      expect(readRegistry(dir)).toEqual(before);
    });
  });

  describe('archived projects', () => {
    test('are excluded by default and included on request', async () => {
      await project('prj_MEM', { name: 'Memento' });
      await updateProject({ id: 'prj_MEM', status: 'archived' }, { projectsDir: dir });

      await expect(resolveProject({ name_hint: 'Memento' }, { projectsDir: dir })).resolves.toEqual(
        { outcome: 'not_found' },
      );
      await expect(
        resolveProject({ name_hint: 'Memento', include_archived: true }, { projectsDir: dir }),
      ).resolves.toMatchObject({ outcome: 'exact_match', project: { status: 'archived' } });
    });
  });

  describe('input validation', () => {
    test('rejects a call with no evidence', async () => {
      await expect(resolveProject({}, { projectsDir: dir })).rejects.toBeInstanceOf(MementoError);
    });

    test('rejects unparseable evidence rather than ignoring it', async () => {
      await expect(
        resolveProject({ git_remote: 'not a remote' }, { projectsDir: dir }),
      ).rejects.toMatchObject({ code: 'validation_error' });
      await expect(
        resolveProject({ working_directory: 'relative/path' }, { projectsDir: dir }),
      ).rejects.toMatchObject({ code: 'validation_error' });
    });
  });
});

function readRegistry(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    out[name] = readFileSync(join(dir, name), 'utf8');
  }
  return out;
}

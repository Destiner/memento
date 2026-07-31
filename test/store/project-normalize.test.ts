import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';

import { MementoError } from '../../src/errors.js';
import {
  deriveRepositorySlug,
  nameKey,
  normalizeGitRemote,
  normalizeRepositorySlug,
  normalizeWorkingDirectory,
  workingDirectoryKey,
} from '../../src/store/project-normalize.js';

describe('normalizeGitRemote', () => {
  const equivalent = [
    'git@github.com:destiner/memento.git',
    'git@github.com:destiner/memento',
    'ssh://git@github.com/destiner/memento.git',
    'https://github.com/destiner/memento.git',
    'https://github.com/destiner/memento',
    'https://github.com/destiner/memento/',
    'git://github.com/destiner/memento.git',
    'github.com/destiner/memento',
  ];

  test.each(equivalent)('%s canonicalizes to github.com/destiner/memento', (remote) => {
    expect(normalizeGitRemote(remote)).toBe('github.com/destiner/memento');
  });

  test('strips embedded credentials so no token reaches the store', () => {
    expect(normalizeGitRemote('https://destiner:ghp_secret@github.com/destiner/memento.git')).toBe(
      'github.com/destiner/memento',
    );
    expect(normalizeGitRemote('https://x-access-token:abc123@github.com/o/r')).not.toContain(
      'abc123',
    );
  });

  test('drops the port', () => {
    expect(normalizeGitRemote('ssh://git@git.example.com:2222/team/repo.git')).toBe(
      'git.example.com/team/repo',
    );
    expect(normalizeGitRemote('https://git.example.com:8443/team/repo')).toBe(
      'git.example.com/team/repo',
    );
  });

  test('reads a leading numeric segment in scp-style syntax as a port', () => {
    expect(normalizeGitRemote('git@git.example.com:2222/team/repo.git')).toBe(
      'git.example.com/team/repo',
    );
  });

  test('keeps a non-numeric scp-style path intact', () => {
    expect(normalizeGitRemote('git@git.example.com:team/repo.git')).toBe(
      'git.example.com/team/repo',
    );
  });

  test('lowercases host and path', () => {
    expect(normalizeGitRemote('git@GitHub.com:Destiner/Memento.git')).toBe(
      'github.com/destiner/memento',
    );
  });

  test('is idempotent', () => {
    for (const remote of [...equivalent, 'ssh://git@git.example.com:2222/team/repo.git']) {
      const once = normalizeGitRemote(remote);
      expect(normalizeGitRemote(once)).toBe(once);
    }
  });

  test('rejects a local filesystem path, which is a working directory not a remote', () => {
    expect(() => normalizeGitRemote('/Users/destiner/repos/bare.git')).toThrow(MementoError);
  });

  test.each(['', '   ', 'github.com', 'https://github.com'])(
    'rejects unusable remote %j',
    (remote) => {
      expect(() => normalizeGitRemote(remote)).toThrow(MementoError);
    },
  );
});

describe('deriveRepositorySlug', () => {
  test('takes the last two path segments', () => {
    expect(deriveRepositorySlug('github.com/destiner/memento')).toBe('destiner/memento');
    expect(deriveRepositorySlug('gitlab.com/group/sub/project')).toBe('sub/project');
  });

  test('returns undefined when there is no owner segment', () => {
    expect(deriveRepositorySlug('git.example.com/repo')).toBeUndefined();
  });
});

describe('normalizeRepositorySlug', () => {
  test('lowercases and drops a .git suffix', () => {
    expect(normalizeRepositorySlug('Destiner/Memento.git')).toBe('destiner/memento');
  });

  test('is idempotent', () => {
    expect(normalizeRepositorySlug(normalizeRepositorySlug('Destiner/Memento.git'))).toBe(
      'destiner/memento',
    );
  });

  test.each(['memento', 'destiner/', '/memento', ''])('rejects %j', (slug) => {
    expect(() => normalizeRepositorySlug(slug)).toThrow(MementoError);
  });
});

describe('normalizeWorkingDirectory', () => {
  let dir: string;
  let real: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'memento-projdir-'));
    real = realpathSync(dir);
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('resolves symlinks so two spellings of one directory compare equal', async () => {
    const target = join(real, 'checkout');
    const link = join(real, 'link');
    mkdirSync(target);
    symlinkSync(target, link);

    expect(await normalizeWorkingDirectory(link)).toBe(target);
    expect(await normalizeWorkingDirectory(target)).toBe(target);
  });

  test('collapses . and .. segments and strips a trailing slash', async () => {
    expect(await normalizeWorkingDirectory(`${real}/./checkout/`)).toBe(join(real, 'checkout'));
    expect(await normalizeWorkingDirectory(`${real}/checkout/../checkout`)).toBe(
      join(real, 'checkout'),
    );
  });

  test('expands a leading ~', async () => {
    expect(await normalizeWorkingDirectory('~')).toBe(await normalizeWorkingDirectory(homedir()));
  });

  test('keeps a path that does not exist rather than rejecting it', async () => {
    const absent = join(real, 'not-mounted-yet');
    expect(await normalizeWorkingDirectory(absent)).toBe(absent);
  });

  test('is idempotent', async () => {
    const once = await normalizeWorkingDirectory(`${real}/./checkout/`);
    expect(await normalizeWorkingDirectory(once)).toBe(once);
  });

  test.each(['relative/path', './here', '', '  '])('rejects non-absolute %j', async (path) => {
    await expect(normalizeWorkingDirectory(path)).rejects.toBeInstanceOf(MementoError);
  });
});

describe('comparison keys', () => {
  test('working directory keys are case-insensitive', () => {
    expect(workingDirectoryKey('/Users/Destiner/Code')).toBe(
      workingDirectoryKey('/users/destiner/code'),
    );
  });

  test('name keys collapse case, punctuation, and diacritics', () => {
    expect(nameKey('Memento')).toBe('memento');
    expect(nameKey('  Memento!  ')).toBe('memento');
    expect(nameKey('ACME SDK')).toBe('acme-sdk');
    expect(nameKey('Café')).toBe('cafe');
  });

  test('does not truncate or fall back the way slugify does', () => {
    const long = 'a'.repeat(70);
    expect(nameKey(long)).toBe(long);
    expect(nameKey('!!!')).toBe('');
  });
});

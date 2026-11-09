import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { importStore } from '../src/import.js';
import { serializeFrontmatter } from '../src/store/frontmatter.js';
import { openIndex } from '../src/store/index-open.js';

let root: string;
let sourceDir: string;
let dataDir: string;
const accountId = 'acct_test';
const timestamp = '2020-01-02T03:04:05.000Z';
const project = {
  id: 'prj_old123',
  name: 'Old project',
  description: 'Existing project',
  status: 'active',
  created_at: timestamp,
  updated_at: timestamp,
};
const memory = {
  id: 'mem_old123',
  title: 'Preserved memory',
  description: 'Existing knowledge',
  scope: { kind: 'projects', project_ids: [project.id] },
  type: 'preference',
  provenance: { source: 'user_stated', verification: 'user_confirmed' },
  status: 'active',
  created_at: timestamp,
  updated_at: timestamp,
  last_accessed_at: timestamp,
};
const memoryName = 'My renamed memory.md';
const projectName = 'Arbitrary project notes.md';
const memoryRaw = serializeFrontmatter(memory, 'Keep this exact body.');
const projectRaw = serializeFrontmatter(project, 'Human project notes.');
const destination = () => join(dataDir, 'accounts', accountId);
const run = () => importStore({ sourceDir, dataDir, accountId });

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'memento-import-')));
  sourceDir = join(root, 'old');
  dataDir = join(root, 'data');
  await mkdir(join(sourceDir, 'memories'), { recursive: true });
  await mkdir(join(sourceDir, 'projects'));
  await writeFile(join(sourceDir, 'memories', memoryName), memoryRaw);
  await writeFile(join(sourceDir, 'projects', projectName), projectRaw);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function snapshot(path: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const name of (await readdir(path)).sort()) {
    const child = join(path, name);
    if ((await stat(child)).isDirectory()) {
      for (const [key, value] of Object.entries(await snapshot(child)))
        result[`${name}/${key}`] = value;
    } else result[name] = (await readFile(child)).toString('base64');
  }
  return result;
}

async function expectRollback(): Promise<void> {
  await expect(run()).rejects.toThrow();
  expect(await readdir(join(dataDir, 'accounts'))).toEqual([]);
}

describe('offline store import', () => {
  it('preserves ids, timestamps, filenames and bytes without touching the source or copying derived files', async () => {
    await mkdir(join(sourceDir, 'index'));
    await writeFile(join(sourceDir, 'index', 'memory.sqlite'), 'not a database');
    await mkdir(join(sourceDir, 'logs'));
    await writeFile(join(sourceDir, 'logs', 'old.log'), 'private log');
    const config = '{"logging_enabled":false,"memory_archive_after_days":1}\n';
    await writeFile(join(sourceDir, 'config.json'), config);
    const before = await snapshot(sourceDir);
    expect(await run()).toEqual({ memories: 1, projects: 1 });
    expect(await snapshot(sourceDir)).toEqual(before);
    expect(await readFile(join(destination(), 'memories', memoryName), 'utf8')).toBe(memoryRaw);
    expect(await readFile(join(destination(), 'projects', projectName), 'utf8')).toBe(projectRaw);
    expect(await readFile(join(destination(), 'config.json'), 'utf8')).toBe(config);
    expect((await readdir(destination())).sort()).toEqual([
      'config.json',
      'index',
      'memories',
      'projects',
    ]);
    const opened = await openIndex({
      indexDir: join(destination(), 'index'),
      memoriesDir: join(destination(), 'memories'),
    });
    try {
      expect(opened.rebuilt).toBe(false);
    } finally {
      opened.index.close();
    }
    expect((await stat(destination())).mode & 0o777).toBe(0o700);
    expect((await stat(join(destination(), 'memories', memoryName))).mode & 0o777).toBe(0o600);
  });

  it.each([
    'bad yaml',
    'unknown field',
    'bad body',
    'duplicate memory',
    'duplicate project',
    'dangling reference',
    'unsafe project id',
    'unknown file',
  ])('rolls back %s', async (kind) => {
    if (kind === 'bad yaml')
      await writeFile(join(sourceDir, 'memories', memoryName), 'not frontmatter');
    if (kind === 'unknown field')
      await writeFile(
        join(sourceDir, 'memories', memoryName),
        serializeFrontmatter({ ...memory, unknown: true }, 'Body'),
      );
    if (kind === 'bad body')
      await writeFile(join(sourceDir, 'memories', memoryName), serializeFrontmatter(memory, ''));
    if (kind === 'duplicate memory')
      await writeFile(join(sourceDir, 'memories', 'duplicate.md'), memoryRaw);
    if (kind === 'duplicate project')
      await writeFile(join(sourceDir, 'projects', 'duplicate.md'), projectRaw);
    if (kind === 'dangling reference') await rm(join(sourceDir, 'projects', projectName));
    if (kind === 'unsafe project id')
      await writeFile(
        join(sourceDir, 'projects', projectName),
        serializeFrontmatter({ ...project, id: '../escape' }, ''),
      );
    if (kind === 'unknown file') await writeFile(join(sourceDir, 'memories', 'extra.json'), '{}');
    const before = await snapshot(sourceDir);
    await expectRollback();
    expect(await snapshot(sourceDir)).toEqual(before);
  });

  it.each([
    'null',
    '[]',
    '{',
    '{"unknown":true}',
    '{"search_backend":"other"}',
    '{"schema_version":2}',
    '{"logging_enabled":0}',
    '{"memory_delete_after_days":0}',
    '{"default_result_limit":11}',
  ])('rejects invalid config %s', async (raw) => {
    await writeFile(join(sourceDir, 'config.json'), raw);
    await expectRollback();
  });

  it('never merges into even an empty existing destination', async () => {
    await mkdir(destination(), { recursive: true });
    await expect(run()).rejects.toThrow('already exists');
    expect(await readdir(destination())).toEqual([]);
    expect(await readdir(join(dataDir, 'accounts'))).toEqual([accountId]);
  });

  it.each(['record', 'directory', 'config', 'derived'])('rejects %s symlinks', async (kind) => {
    const target = join(root, 'external');
    await writeFile(target, memoryRaw);
    const path =
      kind === 'record'
        ? join(sourceDir, 'memories', 'link.md')
        : kind === 'directory'
          ? join(sourceDir, 'projects')
          : kind === 'config'
            ? join(sourceDir, 'config.json')
            : join(sourceDir, 'index');
    if (kind === 'directory') await rm(path, { recursive: true });
    await symlink(target, path);
    await expect(run()).rejects.toThrow(/Symlink/);
    expect(await readFile(target, 'utf8')).toBe(memoryRaw);
  });

  it('rejects symlinked destination parents', async () => {
    await mkdir(dataDir);
    const external = join(root, 'external');
    await mkdir(external);
    await symlink(external, join(dataDir, 'accounts'));
    await expect(run()).rejects.toThrow('real directory');
    expect(await readdir(external)).toEqual([]);
  });

  it.each(['../escape', 'UPPERCASE', '', 'a/b'])('rejects account path %j', async (id) => {
    await expect(importStore({ sourceDir, dataDir, accountId: id })).rejects.toThrow('account id');
  });

  it('rejects overlapping trees and blank explicit paths', async () => {
    await expect(
      importStore({ sourceDir, dataDir: join(sourceDir, 'data'), accountId }),
    ).rejects.toThrow('overlap');
    await expect(importStore({ sourceDir: '', dataDir, accountId })).rejects.toThrow('Explicit');
  });
});
